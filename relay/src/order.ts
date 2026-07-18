import {
  getAddress,
  hashTypedData,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

export const ORDER_TYPE =
  "Order(uint256 salt,address maker,address signer,address taker,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,uint256 feeRateBps,uint8 side,uint8 signatureType)";

export const orderTypes = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "taker", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "expiration", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "feeRateBps", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
  ],
} as const;

export type Order = {
  salt: bigint;
  maker: Address;
  signer: Address;
  taker: Address;
  tokenId: bigint;
  makerAmount: bigint;
  takerAmount: bigint;
  expiration: bigint;
  nonce: bigint;
  feeRateBps: bigint;
  side: number;
  signatureType: number;
};

export type SignedOrder = Order & { signature: Hex };

export type OrderDomain = {
  name: "FireTheCEO Exchange" | "Futarchy Exchange";
  version: "1";
  chainId: number;
  verifyingContract: Address;
};

export const SignatureType = {
  EOA: 0,
  EIP1271: 3,
} as const;

export const Side = {
  BUY: 0,
  SELL: 1,
} as const;

const eip1271Abi = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "magicValue", type: "bytes4" }],
  },
] as const;

const EIP1271_MAGIC_VALUE = "0x1626ba7e";
const UINT256_MAX = (1n << 256n) - 1n;

export function createOrderDomain(
  chainId: number,
  verifyingContract: Address,
  name: OrderDomain["name"] = "FireTheCEO Exchange",
): OrderDomain {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error("chainId must be a positive safe integer");
  }
  return {
    name,
    version: "1",
    chainId,
    verifyingContract: getAddress(verifyingContract),
  };
}

export function unsignedOrder(order: SignedOrder | Order): Order {
  const { signature: _, ...withoutSignature } = order as SignedOrder;
  return withoutSignature;
}

export function hashOrder(order: SignedOrder | Order, domain: OrderDomain): Hex {
  return hashTypedData({
    domain,
    types: orderTypes,
    primaryType: "Order",
    message: unsignedOrder(order),
  });
}

export async function verifySignature(
  order: SignedOrder,
  domain: OrderDomain,
  publicClient?: PublicClient,
): Promise<boolean> {
  if (getAddress(order.maker) !== getAddress(order.signer)) return false;

  if (order.signatureType === SignatureType.EOA) {
    if (order.signature.length !== 132) return false;
    try {
      const recovered = await recoverTypedDataAddress({
        domain,
        types: orderTypes,
        primaryType: "Order",
        message: unsignedOrder(order),
        signature: order.signature,
      });
      return getAddress(recovered) === getAddress(order.signer);
    } catch {
      return false;
    }
  }

  if (order.signatureType === SignatureType.EIP1271) {
    if (!publicClient) throw new Error("EIP-1271 verification requires a public client");
    try {
      const magic = await publicClient.readContract({
        address: order.signer,
        abi: eip1271Abi,
        functionName: "isValidSignature",
        args: [hashOrder(order, domain), order.signature],
      });
      return magic.toLowerCase() === EIP1271_MAGIC_VALUE;
    } catch {
      return false;
    }
  }

  return false;
}

export function parseSignedOrder(value: unknown): SignedOrder {
  if (!value || typeof value !== "object") throw new Error("order must be an object");
  const outer = value as Record<string, unknown>;
  const source =
    outer.order && typeof outer.order === "object"
      ? { ...(outer.order as Record<string, unknown>), signature: outer.signature }
      : outer;

  const order: SignedOrder = {
    salt: parseUint(source.salt, "salt"),
    maker: parseAddress(source.maker, "maker"),
    signer: parseAddress(source.signer, "signer"),
    taker: parseAddress(source.taker, "taker"),
    tokenId: parseUint(source.tokenId, "tokenId"),
    makerAmount: parseUint(source.makerAmount, "makerAmount"),
    takerAmount: parseUint(source.takerAmount, "takerAmount"),
    expiration: parseUint(source.expiration, "expiration"),
    nonce: parseUint(source.nonce, "nonce"),
    feeRateBps: parseUint(source.feeRateBps, "feeRateBps"),
    side: parseUint8(source.side, "side"),
    signatureType: parseUint8(source.signatureType, "signatureType"),
    signature: parseHex(source.signature, "signature"),
  };

  if (order.makerAmount === 0n) throw new Error("makerAmount must be greater than zero");
  if (order.takerAmount === 0n) throw new Error("takerAmount must be greater than zero");
  if (order.side !== Side.BUY && order.side !== Side.SELL) {
    throw new Error("side must be 0 (BUY) or 1 (SELL)");
  }
  if (
    order.signatureType !== SignatureType.EOA &&
    order.signatureType !== SignatureType.EIP1271
  ) {
    throw new Error("signatureType must be 0 (EOA) or 3 (EIP-1271)");
  }
  return order;
}

export function orderToJson(order: SignedOrder): Record<string, string | number> {
  return {
    salt: order.salt.toString(),
    maker: order.maker,
    signer: order.signer,
    taker: order.taker,
    tokenId: order.tokenId.toString(),
    makerAmount: order.makerAmount.toString(),
    takerAmount: order.takerAmount.toString(),
    expiration: order.expiration.toString(),
    nonce: order.nonce.toString(),
    feeRateBps: order.feeRateBps.toString(),
    side: order.side,
    signatureType: order.signatureType,
    signature: order.signature,
  };
}

function parseUint(value: unknown, field: string): bigint {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`${field} must be an unsigned integer string`);
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`${field} must be an unsigned integer string`);
  }
  if (parsed < 0n || parsed > UINT256_MAX) throw new Error(`${field} is outside uint256`);
  return parsed;
}

function parseUint8(value: unknown, field: string): number {
  const parsed = parseUint(value, field);
  if (parsed > 255n) throw new Error(`${field} is outside uint8`);
  return Number(parsed);
}

function parseAddress(value: unknown, field: string): Address {
  if (typeof value !== "string") throw new Error(`${field} must be an address`);
  try {
    return getAddress(value);
  } catch {
    throw new Error(`${field} must be a valid address`);
  }
}

function parseHex(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) {
    throw new Error(`${field} must be non-empty even-length hex bytes`);
  }
  return value as Hex;
}
