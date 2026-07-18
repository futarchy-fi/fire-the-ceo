import {
  getAddress,
  parseAbi,
  toEventSelector,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { Side, type SignedOrder } from "./order.js";

export type ExchangeKind = "ceo" | "erc20";

export const signedOrderTuple =
  "(uint256 salt,address maker,address signer,address taker,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,uint256 feeRateBps,uint8 side,uint8 signatureType,bytes signature)";

export const exchangeWriteAbi = parseAbi([
  `function matchOrders(${signedOrderTuple} takerOrder,${signedOrderTuple}[] makerOrders,uint256 takerFillAmount,uint256[] makerFillAmounts)`,
  `function fillWithAmm(${signedOrderTuple} takerOrder,${signedOrderTuple}[] makerOrders,uint256 takerFillAmount,uint256[] makerFillAmounts,uint256 ammMaxShares)`,
]);

const exchangeReadAbi = parseAbi([
  "function orderStatus(bytes32 orderHash) view returns (bool isFilledOrCancelled,uint256 remaining)",
  "function nonces(address maker) view returns (uint256)",
  "function paused() view returns (bool)",
  "function core() view returns (address)",
  "function companyCount() view returns (uint256)",
  "function getCompany(uint256 companyId) view returns ((string ticker,string name,string ceo,uint32 spotCents,uint32 floorCents,uint32 capCents,uint64 horizon,uint64 settleTime,bool resolved,bool fired,uint32 settledPriceCents,uint64 resolvedAt,string resolutionURI))",
  "function getMarkets(uint256 companyId) view returns ((int128 qL,int128 qS,uint128 b)[3])",
  "function pusd() view returns (address)",
  "function positions(uint256 companyId,uint8 kind,address trader) view returns (uint128 sharesL,uint128 sharesS,uint128 paidIn,uint128 escrow)",
  "function collateralForToken(uint256 tokenId) view returns (address)",
  "function isMarketOpen(uint256 tokenId) view returns (bool)",
]);

const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
]);

export const ORDER_FILLED_TOPICS = new Set<Hex>([
  toEventSelector(
    "OrderFilled(bytes32,address,address,uint256,uint256)",
  ),
  toEventSelector(
    "OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)",
  ),
  toEventSelector(
    "OrderFilled(bytes32,address,address,uint256,uint8,uint256,uint256,uint256)",
  ),
]);

export class ChainValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type OrderChainState = {
  filledOrCancelled: boolean;
  remaining: bigint;
  nonce: bigint;
  blockTimestamp: bigint;
};

export class ExchangeReader {
  private coreAddress?: Address;

  constructor(
    readonly publicClient: PublicClient,
    readonly exchange: Address,
    readonly kind: ExchangeKind,
  ) {}

  async validateForAdmission(order: SignedOrder, hash: Hex): Promise<void> {
    const [block, state] = await Promise.all([
      this.publicClient.getBlock({ blockTag: "latest" }),
      this.getOrderState(hash, order.maker),
    ]);
    if (order.expiration !== 0n && order.expiration < block.timestamp) {
      throw new ChainValidationError("order_expired", "order is expired");
    }
    if (state.filledOrCancelled) {
      throw new ChainValidationError("order_inactive", "order is filled or cancelled on-chain");
    }
    if (state.nonce !== order.nonce) {
      throw new ChainValidationError(
        "nonce_mismatch",
        `order nonce ${order.nonce} does not match maker nonce ${state.nonce}`,
      );
    }
    if (order.feeRateBps > 10_000n) {
      throw new ChainValidationError("fee_too_high", "feeRateBps exceeds the contract maximum of 10000");
    }
    const priceNumerator = order.side === Side.BUY ? order.makerAmount : order.takerAmount;
    const priceDenominator = order.side === Side.BUY ? order.takerAmount : order.makerAmount;
    if (priceNumerator > priceDenominator) {
      throw new ChainValidationError("invalid_price", "order price cannot exceed 1");
    }
    let paused: boolean;
    try {
      paused = await this.publicClient.readContract({
        address: this.exchange,
        abi: exchangeReadAbi,
        functionName: "paused",
      });
    } catch (error) {
      throw new ChainValidationError(
        "chain_read_failed",
        `cannot read exchange pause state: ${shortError(error)}`,
      );
    }
    if (paused) throw new ChainValidationError("exchange_paused", "exchange fills are paused");

    if (this.kind === "ceo") await this.validateCeoOrder(order, block.timestamp);
    else await this.validateErc20Order(order);
  }

  async getOrderState(hash: Hex, maker: Address): Promise<OrderChainState> {
    try {
      const [status, nonce, block] = await Promise.all([
        this.publicClient.readContract({
          address: this.exchange,
          abi: exchangeReadAbi,
          functionName: "orderStatus",
          args: [hash],
        }),
        this.publicClient.readContract({
          address: this.exchange,
          abi: exchangeReadAbi,
          functionName: "nonces",
          args: [maker],
        }),
        this.publicClient.getBlock({ blockTag: "latest" }),
      ]);
      return {
        filledOrCancelled: status[0],
        remaining: status[1],
        nonce,
        blockTimestamp: block.timestamp,
      };
    } catch (error) {
      throw new ChainValidationError(
        "chain_read_failed",
        `cannot read exchange order state: ${shortError(error)}`,
      );
    }
  }

  async getCeoMarket(tokenId: bigint): Promise<{ qL: bigint; qS: bigint; b: bigint }> {
    const core = await this.getCoreAddress();
    const companyId = tokenId / 6n;
    const kind = Number((tokenId % 6n) / 2n);
    const markets = await this.publicClient.readContract({
      address: core,
      abi: exchangeReadAbi,
      functionName: "getMarkets",
      args: [companyId],
    });
    return markets[kind];
  }

  private async validateCeoOrder(order: SignedOrder, now: bigint): Promise<void> {
    const companyId = order.tokenId / 6n;
    const kind = Number((order.tokenId % 6n) / 2n);
    const longSide = order.tokenId % 2n === 0n;
    try {
      const core = await this.getCoreAddress();
      const count = await this.publicClient.readContract({
        address: core,
        abi: exchangeReadAbi,
        functionName: "companyCount",
      });
      if (companyId >= count || kind > 2) {
        throw new ChainValidationError("token_not_registered", "tokenId is not a listed CEO market");
      }
      const company = await this.publicClient.readContract({
        address: core,
        abi: exchangeReadAbi,
        functionName: "getCompany",
        args: [companyId],
      });
      if (company.resolved || now >= company.horizon) {
        throw new ChainValidationError("market_closed", "market is resolved or past its trading horizon");
      }

      if (order.side === Side.BUY) {
        const collateral = await this.publicClient.readContract({
          address: core,
          abi: exchangeReadAbi,
          functionName: "pusd",
        });
        await this.requireErc20Funds(collateral, order.maker, order.makerAmount, core);
      } else {
        const position = await this.publicClient.readContract({
          address: core,
          abi: exchangeReadAbi,
          functionName: "positions",
          args: [companyId, kind, order.maker],
        });
        const balance = longSide ? position[0] : position[1];
        if (balance < order.makerAmount) {
          throw new ChainValidationError(
            "insufficient_balance",
            `maker has ${balance} outcome shares; order requires ${order.makerAmount}`,
          );
        }
      }
    } catch (error) {
      if (error instanceof ChainValidationError) throw error;
      throw new ChainValidationError(
        "chain_read_failed",
        `cannot validate CEO market or funds: ${shortError(error)}`,
      );
    }
  }

  private async validateErc20Order(order: SignedOrder): Promise<void> {
    if (order.tokenId > (1n << 160n) - 1n) {
      throw new ChainValidationError("token_not_registered", "ERC-20 tokenId exceeds uint160");
    }
    try {
      const [collateral, open] = await Promise.all([
        this.publicClient.readContract({
          address: this.exchange,
          abi: exchangeReadAbi,
          functionName: "collateralForToken",
          args: [order.tokenId],
        }),
        this.publicClient.readContract({
          address: this.exchange,
          abi: exchangeReadAbi,
          functionName: "isMarketOpen",
          args: [order.tokenId],
        }),
      ]);
      if (collateral === "0x0000000000000000000000000000000000000000") {
        throw new ChainValidationError("token_not_registered", "tokenId is not registered");
      }
      if (!open) throw new ChainValidationError("market_closed", "market is not open");
      const asset =
        order.side === Side.BUY
          ? collateral
          : getAddress(`0x${order.tokenId.toString(16).padStart(40, "0")}`);
      await this.requireErc20Funds(asset, order.maker, order.makerAmount, this.exchange);
    } catch (error) {
      if (error instanceof ChainValidationError) throw error;
      throw new ChainValidationError(
        "chain_read_failed",
        `cannot validate ERC-20 market or funds: ${shortError(error)}`,
      );
    }
  }

  private async requireErc20Funds(
    token: Address,
    maker: Address,
    required: bigint,
    spender: Address,
  ): Promise<void> {
    const [balance, allowance] = await Promise.all([
      this.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [maker] }),
      this.publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [maker, spender],
      }),
    ]);
    if (balance < required) {
      throw new ChainValidationError(
        "insufficient_balance",
        `maker has ${balance} units of ${token}; order requires ${required}`,
      );
    }
    if (allowance < required) {
      throw new ChainValidationError(
        "insufficient_allowance",
        `maker allowance is ${allowance}; order requires ${required}`,
      );
    }
  }

  private async getCoreAddress(): Promise<Address> {
    if (this.coreAddress) return this.coreAddress;
    this.coreAddress = await this.publicClient.readContract({
      address: this.exchange,
      abi: exchangeReadAbi,
      functionName: "core",
    });
    return this.coreAddress;
  }
}

export function shortError(error: unknown): string {
  if (error instanceof Error) return error.message.split("\n")[0].slice(0, 240);
  return String(error).slice(0, 240);
}
