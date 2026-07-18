import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { OrderBook, storedOrderToJson, type StoredOrder } from "./book.js";
import {
  ChainValidationError,
  ExchangeReader,
  ORDER_FILLED_TOPICS,
  shortError,
  type ExchangeKind,
} from "./exchange.js";
import {
  createOrderDomain,
  hashOrder,
  parseSignedOrder,
  verifySignature,
  type OrderDomain,
} from "./order.js";

type RelayConfig = {
  rpcUrl: string;
  exchange: Address;
  chainId: number;
  port: number;
  exchangeKind: ExchangeKind;
  exchangeName: OrderDomain["name"];
  snapshotPath: string;
  pollIntervalMs: number;
  snapshotIntervalMs: number;
};

class RelayService {
  readonly book = new OrderBook();
  readonly publicClient;
  readonly exchangeReader: ExchangeReader;
  readonly domain: OrderDomain;
  readonly sockets = new Set<WebSocket>();
  private lastScannedBlock = 0n;
  private lastChainBlock = 0n;
  private lastChainError: string | null = null;
  private reconciling = false;
  private snapshotTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;

  constructor(readonly config: RelayConfig) {
    this.publicClient = createPublicClient({ transport: http(config.rpcUrl) });
    this.exchangeReader = new ExchangeReader(
      this.publicClient,
      config.exchange,
      config.exchangeKind,
    );
    this.domain = createOrderDomain(config.chainId, config.exchange, config.exchangeName);
  }

  async start(): Promise<void> {
    const rpcChainId = await this.publicClient.getChainId();
    if (rpcChainId !== this.config.chainId) {
      throw new Error(`RPC chainId ${rpcChainId} does not match CHAIN_ID ${this.config.chainId}`);
    }
    const bytecode = await this.publicClient.getCode({ address: this.config.exchange });
    if (!bytecode) throw new Error(`EXCHANGE_ADDR ${this.config.exchange} has no deployed bytecode`);
    this.lastScannedBlock = await this.publicClient.getBlockNumber();
    this.lastChainBlock = this.lastScannedBlock;
    this.loadSnapshot();
    await this.validateSnapshotSignatures();
    await this.reconcileBook();
    this.pollTimer = setInterval(() => void this.pollChain(), this.config.pollIntervalMs);
    this.snapshotTimer = setInterval(() => void this.saveSnapshot(), this.config.snapshotIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    await this.saveSnapshot();
  }

  async admit(payload: unknown): Promise<{ entry: StoredOrder; added: boolean }> {
    const order = parseSignedOrder(payload);
    const hash = hashOrder(order, this.domain);
    if (!(await verifySignature(order, this.domain, this.publicClient))) {
      throw new ChainValidationError("invalid_signature", "signature does not authorize this order");
    }
    await this.exchangeReader.validateForAdmission(order, hash);
    const existing = this.book.get(hash);
    if (existing) return { entry: existing, added: false };
    const result = this.book.add(hash, order);
    if (result.added) this.broadcastDelta("add", result.entry);
    return result;
  }

  health(): Record<string, unknown> {
    return {
      ok: this.lastChainError === null,
      chainId: this.config.chainId,
      exchange: this.config.exchange,
      exchangeKind: this.config.exchangeKind,
      orders: this.book.size,
      websocketClients: this.sockets.size,
      lastChainBlock: this.lastChainBlock.toString(),
      chainError: this.lastChainError,
    };
  }

  private async pollChain(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const latest = await this.publicClient.getBlockNumber();
      if (latest > this.lastScannedBlock) {
        const logs = await this.publicClient.getLogs({
          address: this.config.exchange,
          fromBlock: this.lastScannedBlock + 1n,
          toBlock: latest,
        });
        for (const log of logs) {
          const topic0 = log.topics[0];
          if (!topic0 || !ORDER_FILLED_TOPICS.has(topic0)) continue;
          const orderHash = log.topics[1] as Hex | undefined;
          this.broadcast({
            type: "fill",
            orderHash: orderHash ?? null,
            blockNumber: log.blockNumber?.toString() ?? null,
            transactionHash: log.transactionHash ?? null,
            data: log.data,
          });
        }
        this.lastScannedBlock = latest;
      }
      this.lastChainBlock = latest;
      await this.reconcileBook();
      this.lastChainError = null;
    } catch (error) {
      this.lastChainError = shortError(error);
      console.error(`[relay] chain poll failed: ${this.lastChainError}`);
    } finally {
      this.reconciling = false;
    }
  }

  private async reconcileBook(): Promise<void> {
    const entries = this.book.all();
    await Promise.all(
      entries.map(async (entry) => {
        try {
          const state = await this.exchangeReader.getOrderState(entry.hash, entry.order.maker);
          let reason: string | undefined;
          if (state.filledOrCancelled) reason = "filled_or_cancelled";
          else if (state.nonce !== entry.order.nonce) reason = "nonce_cancelled";
          else if (state.blockTimestamp >= entry.order.expiration) reason = "expired";
          if (reason) {
            const removed = this.book.remove(entry.hash);
            if (removed) this.broadcastDelta("remove", removed, reason);
          } else if (state.remaining > 0n && state.remaining !== entry.remaining) {
            const updated = this.book.setRemaining(entry.hash, state.remaining);
            if (updated) this.broadcastDelta("update", updated, "partial_fill");
          }
        } catch (error) {
          this.lastChainError = shortError(error);
        }
      }),
    );
  }

  private broadcastDelta(
    action: "add" | "update" | "remove",
    entry: StoredOrder,
    reason?: string,
  ): void {
    this.broadcast({
      type: "book_delta",
      action,
      reason: reason ?? null,
      order: storedOrderToJson(entry),
    });
  }

  private broadcast(message: unknown): void {
    const encoded = JSON.stringify(message);
    for (const socket of this.sockets) {
      if (socket.readyState === socket.OPEN) socket.send(encoded);
    }
  }

  private loadSnapshot(): void {
    if (!existsSync(this.config.snapshotPath)) return;
    try {
      const snapshot = JSON.parse(readFileSync(this.config.snapshotPath, "utf8"));
      const restored = this.book.restore(snapshot, this.domain);
      console.log(`[relay] restored ${restored} orders from ${this.config.snapshotPath}`);
    } catch (error) {
      console.error(`[relay] ignored unreadable snapshot: ${shortError(error)}`);
    }
  }

  private async validateSnapshotSignatures(): Promise<void> {
    await Promise.all(
      this.book.all().map(async (entry) => {
        if (!(await verifySignature(entry.order, this.domain, this.publicClient))) {
          this.book.remove(entry.hash);
          console.error(`[relay] dropped snapshot order ${entry.hash}: invalid signature`);
        }
      }),
    );
  }

  private async saveSnapshot(): Promise<void> {
    const target = this.config.snapshotPath;
    const temporary = `${target}.tmp-${process.pid}`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(this.book.toSnapshot(), null, 2)}\n`);
    await rename(temporary, target);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(dirname(config.snapshotPath), { recursive: true });
  const relay = new RelayService(config);
  await relay.start();

  const server = createServer((request, response) => {
    void handleRequest(relay, request, response);
  });
  const wsServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(request, socket, head, (websocket) => wsServer.emit("connection", websocket));
  });
  wsServer.on("connection", (socket) => {
    relay.sockets.add(socket);
    socket.send(
      JSON.stringify({
        type: "snapshot",
        orders: relay.book.all().map(storedOrderToJson),
      }),
    );
    socket.on("close", () => relay.sockets.delete(socket));
    socket.on("error", () => relay.sockets.delete(socket));
  });

  server.listen(config.port, "0.0.0.0", () => {
    console.log(
      `[relay] listening on :${config.port} for ${config.exchangeName} at ${config.exchange}`,
    );
  });

  const shutdown = async () => {
    server.close();
    wsServer.close();
    await relay.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

async function handleRequest(
  relay: RelayService,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  setCors(response);
  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  try {
    if (request.method === "GET" && url.pathname === "/health") {
      const health = relay.health();
      sendJson(response, health.ok ? 200 : 503, health);
      return;
    }
    if (request.method === "GET" && url.pathname === "/book") {
      const tokenIdValue = url.searchParams.get("tokenId");
      if (tokenIdValue === null) throw new HttpError(400, "missing_token_id", "tokenId is required");
      let tokenId: bigint;
      try {
        tokenId = BigInt(tokenIdValue);
      } catch {
        throw new HttpError(400, "invalid_token_id", "tokenId must be an unsigned integer");
      }
      if (tokenId < 0n) throw new HttpError(400, "invalid_token_id", "tokenId must be unsigned");
      sendJson(response, 200, { tokenId: tokenId.toString(), orders: relay.book.byToken(tokenId).map(storedOrderToJson) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/orders") {
      const maker = url.searchParams.get("maker");
      if (!maker || !isAddress(maker)) {
        throw new HttpError(400, "invalid_maker", "maker must be a valid address");
      }
      sendJson(response, 200, { maker: getAddress(maker), orders: relay.book.byMaker(maker).map(storedOrderToJson) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/orders") {
      const body = await readJsonBody(request);
      const result = await relay.admit(body);
      sendJson(response, result.added ? 201 : 200, {
        accepted: true,
        duplicate: !result.added,
        order: storedOrderToJson(result.entry),
      });
      return;
    }
    throw new HttpError(404, "not_found", "route not found");
  } catch (error) {
    if (error instanceof HttpError || error instanceof ChainValidationError) {
      sendJson(response, error instanceof HttpError ? error.status : 422, {
        accepted: false,
        error: error.code,
        message: error.message,
      });
      return;
    }
    sendJson(response, 400, { accepted: false, error: "invalid_request", message: shortError(error) });
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 64 * 1024) throw new HttpError(413, "body_too_large", "request body exceeds 64 KiB");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "request body must be valid JSON");
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(encoded);
}

function setCors(response: ServerResponse): void {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
}

function loadConfig(): RelayConfig {
  const rpcUrl = requiredEnv("RPC_URL");
  const exchangeValue = requiredEnv("EXCHANGE_ADDR");
  if (!isAddress(exchangeValue)) throw new Error("EXCHANGE_ADDR must be a valid address");
  const exchangeKindValue = process.env.EXCHANGE_KIND ?? "ceo";
  if (exchangeKindValue !== "ceo" && exchangeKindValue !== "erc20") {
    throw new Error("EXCHANGE_KIND must be ceo or erc20");
  }
  const defaultName = exchangeKindValue === "ceo" ? "FireTheCEO Exchange" : "Futarchy Exchange";
  const exchangeName = process.env.EXCHANGE_NAME ?? defaultName;
  if (exchangeName !== "FireTheCEO Exchange" && exchangeName !== "Futarchy Exchange") {
    throw new Error('EXCHANGE_NAME must be "FireTheCEO Exchange" or "Futarchy Exchange"');
  }
  return {
    rpcUrl,
    exchange: getAddress(exchangeValue),
    chainId: positiveIntegerEnv("CHAIN_ID"),
    port: positiveIntegerEnv("PORT", 8080),
    exchangeKind: exchangeKindValue,
    exchangeName,
    snapshotPath: resolve(process.env.SNAPSHOT_PATH ?? "./data/orders.json"),
    pollIntervalMs: positiveIntegerEnv("POLL_INTERVAL_MS", 4_000),
    snapshotIntervalMs: positiveIntegerEnv("SNAPSHOT_INTERVAL_MS", 10_000),
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

main().catch((error) => {
  console.error(`[relay] fatal: ${shortError(error)}`);
  process.exit(1);
});
