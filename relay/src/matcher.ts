import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import WebSocket from "ws";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type JsonStoredOrder, type StoredOrder } from "./book.js";
import { exchangeWriteAbi, ExchangeReader, shortError, type ExchangeKind } from "./exchange.js";
import { ammSharesToLimit, ammTakerFillAmount, findBestCross } from "./matching.js";
import { parseSignedOrder, type SignedOrder } from "./order.js";

type MatcherConfig = {
  relayWsUrl: string;
  rpcUrl: string;
  exchange: Address;
  chainId: number;
  exchangeKind: ExchangeKind;
  hasAmm: boolean;
  ammMaxShares: bigint;
  privateKey: Hex;
  retryMs: number;
};

class Matcher {
  private readonly entries = new Map<Hex, StoredOrder>();
  private readonly pending = new Set<string>();
  private readonly publicClient;
  private readonly walletClient;
  private readonly exchangeReader: ExchangeReader;
  private readonly account;
  private socket?: WebSocket;
  private processing = false;
  private stopped = false;

  constructor(readonly config: MatcherConfig) {
    const chain = defineChain({
      id: config.chainId,
      name: `exchange-${config.chainId}`,
      nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrl] } },
    });
    this.account = privateKeyToAccount(config.privateKey);
    this.publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) });
    this.walletClient = createWalletClient({ account: this.account, chain, transport: http(config.rpcUrl) });
    this.exchangeReader = new ExchangeReader(this.publicClient, config.exchange, config.exchangeKind);
  }

  async start(): Promise<void> {
    const rpcChainId = await this.publicClient.getChainId();
    if (rpcChainId !== this.config.chainId) {
      throw new Error(`RPC chainId ${rpcChainId} does not match CHAIN_ID ${this.config.chainId}`);
    }
    const bytecode = await this.publicClient.getCode({ address: this.config.exchange });
    if (!bytecode) throw new Error(`EXCHANGE_ADDR ${this.config.exchange} has no deployed bytecode`);
    console.log(`[matcher] account ${this.account.address}; AMM ${this.config.hasAmm ? "enabled" : "disabled"}`);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
  }

  private connect(): void {
    if (this.stopped) return;
    const socket = new WebSocket(this.config.relayWsUrl);
    this.socket = socket;
    socket.on("open", () => console.log(`[matcher] watching ${this.config.relayWsUrl}`));
    socket.on("message", (data) => {
      try {
        this.handleMessage(JSON.parse(String(data)));
      } catch (error) {
        console.error(`[matcher] ignored relay message: ${shortError(error)}`);
      }
    });
    socket.on("error", (error) => console.error(`[matcher] websocket error: ${shortError(error)}`));
    socket.on("close", () => {
      this.socket = undefined;
      if (!this.stopped) setTimeout(() => this.connect(), this.config.retryMs);
    });
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const payload = message as { type?: string; action?: string; order?: JsonStoredOrder; orders?: JsonStoredOrder[] };
    if (payload.type === "snapshot" && Array.isArray(payload.orders)) {
      this.entries.clear();
      for (const raw of payload.orders) {
        const entry = parseStoredOrder(raw);
        this.entries.set(entry.hash, entry);
      }
      void this.processBook();
    } else if (payload.type === "book_delta" && payload.order) {
      const entry = parseStoredOrder(payload.order);
      if (payload.action === "remove") this.entries.delete(entry.hash);
      else this.entries.set(entry.hash, entry);
      void this.processBook();
    }
  }

  private async processBook(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (!this.stopped) {
        const authorizedTakers = new Set([
          this.account.address.toLowerCase(),
          this.config.exchange.toLowerCase(),
        ]);
        const cross = findBestCross(
          [...this.entries.values()],
          this.pending,
          authorizedTakers,
          this.config.exchangeKind === "ceo",
        );
        if (cross) {
          await this.submitBookCross(cross.taker, cross.maker, cross.takerFillAmount, cross.makerFillAmount);
          continue;
        }
        if (this.config.hasAmm && this.config.exchangeKind === "ceo") {
          const submitted = await this.submitFirstAmmCross();
          if (submitted) continue;
        }
        break;
      }
    } finally {
      this.processing = false;
    }
  }

  private async submitBookCross(
    taker: StoredOrder,
    maker: StoredOrder,
    takerFillAmount: bigint,
    makerFillAmount: bigint,
  ): Promise<void> {
    this.pending.add(taker.hash);
    this.pending.add(maker.hash);
    try {
      const hash = await this.walletClient.writeContract({
        address: this.config.exchange,
        abi: exchangeWriteAbi,
        functionName: "matchOrders",
        args: [toContractOrder(taker.order), [toContractOrder(maker.order)], takerFillAmount, [makerFillAmount]],
      });
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
      console.log(`[matcher] matched ${taker.hash} with ${maker.hash}: ${hash}`);
    } catch (error) {
      console.error(`[matcher] book match failed: ${shortError(error)}`);
    } finally {
      setTimeout(() => {
        this.pending.delete(taker.hash);
        this.pending.delete(maker.hash);
        void this.processBook();
      }, this.config.retryMs);
    }
  }

  private async submitFirstAmmCross(): Promise<boolean> {
    const publicOrders = [...this.entries.values()]
      .filter(
        (entry) =>
          !this.pending.has(entry.hash) &&
          (entry.order.taker === "0x0000000000000000000000000000000000000000" ||
            entry.order.taker === this.account.address ||
            entry.order.taker === this.config.exchange),
      )
      .sort((a, b) => a.sequence - b.sequence);
    for (const entry of publicOrders) {
      try {
        const market = await this.exchangeReader.getCeoMarket(entry.order.tokenId);
        const shares = ammSharesToLimit(entry, market, this.config.ammMaxShares);
        if (shares === 0n) continue;
        this.pending.add(entry.hash);
        const hash = await this.walletClient.writeContract({
          address: this.config.exchange,
          abi: exchangeWriteAbi,
          functionName: "fillWithAmm",
          args: [toContractOrder(entry.order), [], ammTakerFillAmount(entry, shares), [], shares],
        });
        const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
        console.log(`[matcher] filled ${entry.hash} against LMSR for up to ${shares} shares: ${hash}`);
        setTimeout(() => {
          this.pending.delete(entry.hash);
          void this.processBook();
        }, this.config.retryMs);
        return true;
      } catch (error) {
        this.pending.delete(entry.hash);
        console.error(`[matcher] AMM match for ${entry.hash} failed: ${shortError(error)}`);
      }
    }
    return false;
  }
}

function parseStoredOrder(raw: JsonStoredOrder): StoredOrder {
  return {
    hash: raw.hash,
    order: parseSignedOrder(raw.order),
    remaining: BigInt(raw.remaining),
    receivedAt: Number(raw.receivedAt),
    sequence: Number(raw.sequence),
  };
}

function toContractOrder(order: SignedOrder) {
  return {
    salt: order.salt,
    maker: order.maker,
    signer: order.signer,
    taker: order.taker,
    tokenId: order.tokenId,
    makerAmount: order.makerAmount,
    takerAmount: order.takerAmount,
    expiration: order.expiration,
    nonce: order.nonce,
    feeRateBps: order.feeRateBps,
    side: order.side,
    signatureType: order.signatureType,
    signature: order.signature,
  };
}

function loadConfig(): MatcherConfig {
  const exchangeValue = requiredEnv("EXCHANGE_ADDR");
  if (!isAddress(exchangeValue)) throw new Error("EXCHANGE_ADDR must be a valid address");
  const privateKey = requiredEnv("MATCHER_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("MATCHER_PRIVATE_KEY must be a 32-byte hex private key");
  }
  const exchangeKind = process.env.EXCHANGE_KIND ?? "ceo";
  if (exchangeKind !== "ceo" && exchangeKind !== "erc20") {
    throw new Error("EXCHANGE_KIND must be ceo or erc20");
  }
  return {
    relayWsUrl: process.env.RELAY_WS_URL ?? "ws://relay:8080/ws",
    rpcUrl: requiredEnv("RPC_URL"),
    exchange: getAddress(exchangeValue),
    chainId: positiveIntegerEnv("CHAIN_ID"),
    exchangeKind,
    hasAmm: booleanEnv("EXCHANGE_HAS_AMM", false),
    ammMaxShares: BigInt(process.env.AMM_MAX_SHARES ?? ((1n << 128n) - 1n).toString()),
    privateKey: privateKey as Hex,
    retryMs: positiveIntegerEnv("MATCHER_RETRY_MS", 4_000),
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveIntegerEnv(name: string, fallback?: number): number {
  const raw = process.env[name];
  if (raw === undefined && fallback !== undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name} must be true/false or 1/0`);
}

async function main(): Promise<void> {
  const matcher = new Matcher(loadConfig());
  await matcher.start();
  process.once("SIGINT", () => matcher.stop());
  process.once("SIGTERM", () => matcher.stop());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[matcher] fatal: ${shortError(error)}`);
    process.exit(1);
  });
}
