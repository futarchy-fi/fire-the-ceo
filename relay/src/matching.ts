import { priceFraction, type StoredOrder } from "./book.js";
import { Side } from "./order.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type Cross = {
  taker: StoredOrder;
  maker: StoredOrder;
  shares: bigint;
  takerFillAmount: bigint;
  makerFillAmount: bigint;
};

export function findBestCross(
  entries: StoredOrder[],
  pending = new Set<string>(),
  authorizedTakers = new Set<string>(),
  includeComplementPairs = false,
): Cross | undefined {
  const buys = entries
    .filter((entry) => entry.order.side === Side.BUY && !pending.has(entry.hash))
    .sort((a, b) => comparePrice(a, b, true));
  const sells = entries
    .filter((entry) => entry.order.side === Side.SELL && !pending.has(entry.hash))
    .sort((a, b) => comparePrice(a, b, false));

  for (const buy of buys) {
    for (const sell of sells) {
      if (buy.order.tokenId !== sell.order.tokenId || buy.order.maker === sell.order.maker) continue;
      if (!counterpartyAllowed(buy, authorizedTakers) || !counterpartyAllowed(sell, authorizedTakers)) {
        continue;
      }
      if (!pricesCross(buy, sell)) break;
      const buyShares = (buy.remaining * buy.order.takerAmount) / buy.order.makerAmount;
      const shares = min(buyShares, sell.remaining);
      if (shares === 0n) continue;

      if (buy.sequence > sell.sequence) {
        const takerFill = (shares * buy.order.makerAmount) / buy.order.takerAmount;
        const makerCost = mulDivUp(shares, sell.order.takerAmount, sell.order.makerAmount);
        if (takerFill === 0n || makerCost > takerFill) continue;
        return {
          taker: buy,
          maker: sell,
          shares,
          takerFillAmount: takerFill,
          makerFillAmount: shares,
        };
      }
      const makerFill = (shares * buy.order.makerAmount) / buy.order.takerAmount;
      if (makerFill === 0n) continue;
      const actualShares = mulDivUp(makerFill, buy.order.takerAmount, buy.order.makerAmount);
      const sellerTarget = mulDivUp(actualShares, sell.order.takerAmount, sell.order.makerAmount);
      if (actualShares > sell.remaining || makerFill < sellerTarget) continue;
      return {
        taker: sell,
        maker: buy,
        shares: actualShares,
        takerFillAmount: actualShares,
        makerFillAmount: makerFill,
      };
    }
  }
  return includeComplementPairs
    ? findComplementPairCross(entries, pending, authorizedTakers)
    : undefined;
}

export function ammSharesToLimit(
  entry: StoredOrder,
  market: { qL: bigint; qS: bigint; b: bigint },
  cap: bigint,
): bigint {
  if (market.b <= 0n || cap <= 0n) return 0n;
  const longSide = entry.order.tokenId % 2n === 0n;
  const qSide = longSide ? market.qL : market.qS;
  const qOther = longSide ? market.qS : market.qL;
  const x = ratioToNumber(qSide - qOther, market.b);
  const current = sigmoid(x);
  const [numerator, denominator] = priceFraction(entry.order);
  const limit = clampProbability(ratioToNumber(numerator, denominator));
  let deltaLogit: number;
  if (entry.order.side === Side.BUY) {
    if (current >= limit) return 0n;
    deltaLogit = logit(limit) - logit(current);
  } else {
    if (current <= limit) return 0n;
    deltaLogit = logit(current) - logit(limit);
  }
  const scale = 1_000_000_000n;
  const scaledDelta = BigInt(Math.floor(deltaLogit * Number(scale)));
  const curveShares = (market.b * scaledDelta) / scale;
  const orderShares =
    entry.order.side === Side.BUY
      ? (entry.remaining * entry.order.takerAmount) / entry.order.makerAmount
      : entry.remaining;
  return min(curveShares, orderShares, cap);
}

export function ammTakerFillAmount(entry: StoredOrder, shares: bigint): bigint {
  return entry.order.side === Side.BUY
    ? (shares * entry.order.makerAmount) / entry.order.takerAmount
    : shares;
}

function pricesCross(buy: StoredOrder, sell: StoredOrder): boolean {
  return (
    buy.order.makerAmount * sell.order.makerAmount >=
    sell.order.takerAmount * buy.order.takerAmount
  );
}

function counterpartyAllowed(entry: StoredOrder, authorizedTakers: Set<string>): boolean {
  const taker = entry.order.taker.toLowerCase();
  return taker === ZERO_ADDRESS || authorizedTakers.has(taker);
}

function findComplementPairCross(
  entries: StoredOrder[],
  pending: Set<string>,
  authorizedTakers: Set<string>,
): Cross | undefined {
  const available = entries
    .filter((entry) => !pending.has(entry.hash) && counterpartyAllowed(entry, authorizedTakers))
    .sort((a, b) => a.sequence - b.sequence);
  for (let leftIndex = 0; leftIndex < available.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < available.length; rightIndex += 1) {
      const left = available[leftIndex];
      const right = available[rightIndex];
      if (
        left.order.maker === right.order.maker ||
        left.order.side !== right.order.side ||
        (left.order.tokenId ^ 1n) !== right.order.tokenId ||
        !complementPricesCross(left, right)
      ) {
        continue;
      }
      const maker = left;
      const taker = right;
      if (taker.order.side === Side.BUY) {
        const makerShareCapacity =
          (maker.remaining * maker.order.takerAmount) / maker.order.makerAmount;
        const takerShareCapacity =
          (taker.remaining * taker.order.takerAmount) / taker.order.makerAmount;
        const targetShares = min(makerShareCapacity, takerShareCapacity);
        const makerFill =
          (targetShares * maker.order.makerAmount) / maker.order.takerAmount;
        if (makerFill === 0n) continue;
        const shares = mulDivUp(makerFill, maker.order.takerAmount, maker.order.makerAmount);
        const takerFill = shares - makerFill;
        if (
          takerFill === 0n ||
          takerFill > taker.remaining ||
          mulDivUp(takerFill, taker.order.takerAmount, taker.order.makerAmount) > shares
        ) {
          continue;
        }
        return { taker, maker, shares, takerFillAmount: takerFill, makerFillAmount: makerFill };
      }

      const shares = min(maker.remaining, taker.remaining);
      const makerTaking = mulDivUp(shares, maker.order.takerAmount, maker.order.makerAmount);
      const takerTarget = mulDivUp(shares, taker.order.takerAmount, taker.order.makerAmount);
      if (makerTaking > shares || shares - makerTaking < takerTarget) continue;
      return { taker, maker, shares, takerFillAmount: shares, makerFillAmount: shares };
    }
  }
  return undefined;
}

function complementPricesCross(a: StoredOrder, b: StoredOrder): boolean {
  const [aN, aD] = priceFraction(a.order);
  const [bN, bD] = priceFraction(b.order);
  const sumNumerator = aN * bD + bN * aD;
  const denominator = aD * bD;
  return a.order.side === Side.BUY ? sumNumerator >= denominator : sumNumerator <= denominator;
}

function comparePrice(a: StoredOrder, b: StoredOrder, descending: boolean): number {
  const [aN, aD] = priceFraction(a.order);
  const [bN, bD] = priceFraction(b.order);
  const difference = aN * bD - bN * aD;
  if (difference === 0n) return a.sequence - b.sequence;
  if (descending) return difference > 0n ? -1 : 1;
  return difference < 0n ? -1 : 1;
}

function mulDivUp(a: bigint, b: bigint, denominator: bigint): bigint {
  return (a * b + denominator - 1n) / denominator;
}

function min(...values: bigint[]): bigint {
  return values.reduce((smallest, value) => (value < smallest ? value : smallest));
}

function ratioToNumber(numerator: bigint, denominator: bigint): number {
  const scale = 1_000_000_000_000n;
  return Number((numerator * scale) / denominator) / Number(scale);
}

function clampProbability(value: number): number {
  return Math.min(1 - 1e-12, Math.max(1e-12, value));
}

function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

function logit(probability: number): number {
  const clamped = clampProbability(probability);
  return Math.log(clamped / (1 - clamped));
}
