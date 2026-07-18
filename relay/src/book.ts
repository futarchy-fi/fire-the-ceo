import type { Hex } from "viem";
import { hashOrder, orderToJson, parseSignedOrder, Side, type OrderDomain, type SignedOrder } from "./order.js";

export type StoredOrder = {
  hash: Hex;
  order: SignedOrder;
  remaining: bigint;
  receivedAt: number;
  sequence: number;
};

export type JsonStoredOrder = {
  hash: Hex;
  order: Record<string, string | number>;
  remaining: string;
  receivedAt: number;
  sequence: number;
};

export class OrderBook {
  private readonly entries = new Map<Hex, StoredOrder>();
  private nextSequence = 1;

  get size(): number {
    return this.entries.size;
  }

  add(hash: Hex, order: SignedOrder, receivedAt = Date.now()): { entry: StoredOrder; added: boolean } {
    const existing = this.entries.get(hash);
    if (existing) return { entry: existing, added: false };
    const entry = {
      hash,
      order,
      remaining: order.makerAmount,
      receivedAt,
      sequence: this.nextSequence++,
    };
    this.entries.set(hash, entry);
    return { entry, added: true };
  }

  get(hash: Hex): StoredOrder | undefined {
    return this.entries.get(hash);
  }

  remove(hash: Hex): StoredOrder | undefined {
    const entry = this.entries.get(hash);
    if (entry) this.entries.delete(hash);
    return entry;
  }

  setRemaining(hash: Hex, remaining: bigint): StoredOrder | undefined {
    const entry = this.entries.get(hash);
    if (!entry) return undefined;
    entry.remaining = remaining;
    return entry;
  }

  all(): StoredOrder[] {
    return [...this.entries.values()];
  }

  byMaker(maker: string): StoredOrder[] {
    const normalized = maker.toLowerCase();
    return this.all()
      .filter((entry) => entry.order.maker.toLowerCase() === normalized)
      .sort((a, b) => a.sequence - b.sequence);
  }

  byToken(tokenId: bigint): StoredOrder[] {
    return this.all()
      .filter((entry) => entry.order.tokenId === tokenId)
      .sort(comparePriceTime);
  }

  toSnapshot(): JsonStoredOrder[] {
    return this.all().map(storedOrderToJson);
  }

  restore(snapshot: unknown, domain: OrderDomain): number {
    if (!Array.isArray(snapshot)) throw new Error("snapshot must be an array");
    let restored = 0;
    for (const item of snapshot) {
      if (!item || typeof item !== "object") continue;
      try {
        const raw = item as Partial<JsonStoredOrder>;
        const order = parseSignedOrder(raw.order);
        const hash = hashOrder(order, domain);
        if (hash !== raw.hash) continue;
        const remaining = BigInt(raw.remaining ?? order.makerAmount);
        if (remaining <= 0n || remaining > order.makerAmount) continue;
        const entry = this.add(hash, order, Number(raw.receivedAt) || Date.now()).entry;
        entry.remaining = remaining;
        entry.sequence = Number(raw.sequence) || entry.sequence;
        this.nextSequence = Math.max(this.nextSequence, entry.sequence + 1);
        restored += 1;
      } catch {
        // Skip corrupt or stale snapshot entries individually.
      }
    }
    return restored;
  }
}

export function storedOrderToJson(entry: StoredOrder): JsonStoredOrder {
  return {
    hash: entry.hash,
    order: orderToJson(entry.order),
    remaining: entry.remaining.toString(),
    receivedAt: entry.receivedAt,
    sequence: entry.sequence,
  };
}

function comparePriceTime(a: StoredOrder, b: StoredOrder): number {
  if (a.order.side !== b.order.side) return a.order.side - b.order.side;
  const [aNumerator, aDenominator] = priceFraction(a.order);
  const [bNumerator, bDenominator] = priceFraction(b.order);
  const comparison = aNumerator * bDenominator - bNumerator * aDenominator;
  if (comparison !== 0n) {
    if (a.order.side === Side.SELL) return comparison < 0n ? -1 : 1;
    return comparison > 0n ? -1 : 1;
  }
  return a.sequence - b.sequence;
}

export function priceFraction(order: SignedOrder): [bigint, bigint] {
  return order.side === Side.BUY
    ? [order.makerAmount, order.takerAmount]
    : [order.takerAmount, order.makerAmount];
}
