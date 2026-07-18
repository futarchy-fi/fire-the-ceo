import type { Address, Hex } from 'viem'

export const orderTypes = {
  Order: [
    { name: 'salt', type: 'uint256' }, { name: 'maker', type: 'address' }, { name: 'signer', type: 'address' },
    { name: 'taker', type: 'address' }, { name: 'tokenId', type: 'uint256' }, { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' }, { name: 'expiration', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
    { name: 'feeRateBps', type: 'uint256' }, { name: 'side', type: 'uint8' }, { name: 'signatureType', type: 'uint8' },
  ],
} as const

export type Order = {
  salt: bigint; maker: Address; signer: Address; taker: Address; tokenId: bigint
  makerAmount: bigint; takerAmount: bigint; expiration: bigint; nonce: bigint
  feeRateBps: bigint; side: number; signatureType: number
}
export type SignedOrder = Order & { signature: Hex }
export type StoredOrder = { hash: Hex; order: SignedOrder; remaining: bigint; receivedAt: number; sequence: number }

function bigintField(value: unknown): bigint { return BigInt(String(value)) }

export function parseStoredOrder(value: unknown): StoredOrder | null {
  if (!value || typeof value !== 'object') return null
  const stored = value as Record<string, unknown>
  if (!stored.order || typeof stored.order !== 'object') return null
  const order = stored.order as Record<string, unknown>
  try {
    return {
      hash: String(stored.hash) as Hex,
      remaining: bigintField(stored.remaining),
      receivedAt: Number(stored.receivedAt), sequence: Number(stored.sequence),
      order: {
        salt: bigintField(order.salt), maker: String(order.maker) as Address, signer: String(order.signer) as Address,
        taker: String(order.taker) as Address, tokenId: bigintField(order.tokenId), makerAmount: bigintField(order.makerAmount),
        takerAmount: bigintField(order.takerAmount), expiration: bigintField(order.expiration), nonce: bigintField(order.nonce),
        feeRateBps: bigintField(order.feeRateBps), side: Number(order.side), signatureType: Number(order.signatureType), signature: String(order.signature) as Hex,
      },
    }
  } catch { return null }
}

export function orderPrice(order: Order): number {
  return order.side === 0 ? Number(order.makerAmount) / Number(order.takerAmount) : Number(order.takerAmount) / Number(order.makerAmount)
}

export function orderShares(entry: StoredOrder): number {
  return entry.order.side === 0 ? Number(entry.remaining) / orderPrice(entry.order) : Number(entry.remaining)
}

export function orderToJson(order: SignedOrder): Record<string, string | number> {
  return {
    salt: order.salt.toString(), maker: order.maker, signer: order.signer, taker: order.taker,
    tokenId: order.tokenId.toString(), makerAmount: order.makerAmount.toString(), takerAmount: order.takerAmount.toString(),
    expiration: order.expiration.toString(), nonce: order.nonce.toString(), feeRateBps: order.feeRateBps.toString(),
    side: order.side, signatureType: order.signatureType, signature: order.signature,
  }
}
