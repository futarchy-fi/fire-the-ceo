import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { OrderBook } from "./book.js";
import { findBestCross } from "./matching.js";
import {
  createOrderDomain,
  hashOrder,
  orderTypes,
  type SignedOrder,
  unsignedOrder,
  verifySignature,
} from "./order.js";

const CHAIN_ID = 31_337;
const PORT = Number(process.env.SELF_CHECK_PORT ?? "18545");
const RPC_URL = `http://127.0.0.1:${PORT}`;
const DEPLOYER_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const MAKER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const SELLER_KEY = "0x0000000000000000000000000000000000000000000000000000000000000003" as Hex;
const EXCHANGE = getAddress("0x1111111111111111111111111111111111111111");
const EXPECTED_VECTOR = "0x0ab0a3d9151bc4d0c425befbdb626f80270eb574472cb5644f25e8b98d106e2c";

let anvil: ChildProcess | undefined;

try {
  const forge = findFoundryTool("forge");
  const anvilPath = findFoundryTool("anvil");
  compileReference(forge);
  anvil = spawn(anvilPath, ["--silent", "--port", String(PORT), "--chain-id", String(CHAIN_ID)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForAnvil(anvil);

  const publicClient = createPublicClient({ transport: http(RPC_URL) });
  const deployer = privateKeyToAccount(DEPLOYER_KEY);
  const walletClient = createWalletClient({ account: deployer, transport: http(RPC_URL) });
  const artifact = JSON.parse(
    readFileSync(join(process.cwd(), "out/HashOrderReference.sol/HashOrderReference.json"), "utf8"),
  ) as { abi: readonly unknown[]; bytecode: { object: Hex } };
  const deployHash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    chain: null,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  assert.equal(receipt.status, "success", "reference hasher deployment failed");
  assert(receipt.contractAddress, "reference hasher has no deployed address");

  const maker = privateKeyToAccount(MAKER_KEY);
  const domain = createOrderDomain(CHAIN_ID, EXCHANGE);
  const unsigned = {
    salt: 42n,
    maker: maker.address,
    signer: maker.address,
    taker: "0x0000000000000000000000000000000000000000" as Address,
    tokenId: 17n,
    makerAmount: 350_000_000_000_000_000n,
    takerAmount: 1_000_000_000_000_000_000n,
    expiration: 2_000_000_000n,
    nonce: 7n,
    feeRateBps: 0n,
    side: 0,
    signatureType: 0,
  };
  const signature = await maker.signTypedData({
    domain,
    types: orderTypes,
    primaryType: "Order",
    message: unsigned,
  });
  const order: SignedOrder = { ...unsigned, signature };

  const localHash = hashOrder(order, domain);
  const onChainHash = (await publicClient.readContract({
    address: receipt.contractAddress,
    abi: artifact.abi,
    functionName: "hashOrder",
    args: [unsignedOrder(order), domain.name, BigInt(CHAIN_ID), EXCHANGE],
  })) as Hex;

  assert.equal(localHash, EXPECTED_VECTOR, "known order hash vector changed");
  assert.equal(localHash, onChainHash, "order.ts digest differs from Solidity reference");
  assert.equal(await verifySignature(order, domain, publicClient), true, "valid EOA signature rejected");
  assert.equal(
    await verifySignature({ ...order, makerAmount: order.makerAmount + 1n }, domain, publicClient),
    false,
    "mutated order signature accepted",
  );

  const seller = privateKeyToAccount(SELLER_KEY);
  const unsignedSell = {
    ...unsigned,
    salt: 43n,
    maker: seller.address,
    signer: seller.address,
    makerAmount: 1_000_000_000_000_000_000n,
    takerAmount: 300_000_000_000_000_000n,
    side: 1,
  };
  const sellOrder: SignedOrder = {
    ...unsignedSell,
    signature: await seller.signTypedData({
      domain,
      types: orderTypes,
      primaryType: "Order",
      message: unsignedSell,
    }),
  };
  assert.equal(await verifySignature(sellOrder, domain, publicClient), true);
  const book = new OrderBook();
  book.add(localHash, order);
  book.add(hashOrder(sellOrder, domain), sellOrder);
  assert.equal(book.size, 2, "relay book did not retain both signed orders");
  const cross = findBestCross(book.all());
  assert(cross, "matcher did not find crossing BUY 0.35 / SELL 0.30");
  assert.equal(cross.shares, 1_000_000_000_000_000_000n);
  assert.equal(cross.makerFillAmount, 350_000_000_000_000_000n);

  const mintLongUnsigned = {
    ...unsigned,
    salt: 44n,
    tokenId: 16n,
    makerAmount: 600_000_000_000_000_000n,
  };
  const mintShortUnsigned = {
    ...unsignedSell,
    salt: 45n,
    tokenId: 17n,
    makerAmount: 400_000_000_000_000_000n,
    takerAmount: 1_000_000_000_000_000_000n,
    side: 0,
  };
  const mintLong: SignedOrder = {
    ...mintLongUnsigned,
    signature: await maker.signTypedData({
      domain,
      types: orderTypes,
      primaryType: "Order",
      message: mintLongUnsigned,
    }),
  };
  const mintShort: SignedOrder = {
    ...mintShortUnsigned,
    signature: await seller.signTypedData({
      domain,
      types: orderTypes,
      primaryType: "Order",
      message: mintShortUnsigned,
    }),
  };
  const mintBook = new OrderBook();
  mintBook.add(hashOrder(mintLong, domain), mintLong);
  mintBook.add(hashOrder(mintShort, domain), mintShort);
  const mintCross = findBestCross(mintBook.all(), new Set(), new Set(), true);
  assert(mintCross, "matcher did not find complementary BUY/BUY mint cross");
  assert.equal(mintCross.takerFillAmount, 400_000_000_000_000_000n);
  assert.equal(mintCross.makerFillAmount, 600_000_000_000_000_000n);

  console.log(`PASS EIP-712 hash: ${localHash}`);
  console.log("PASS EOA signature recovery and mutation rejection");
  console.log("PASS relay book storage and signed COMPLEMENTARY/MINT cross matching");
  console.log(`PASS Solidity reference on Anvil chain ${CHAIN_ID}`);
} finally {
  if (anvil && anvil.exitCode === null) anvil.kill("SIGTERM");
}

function findFoundryTool(name: "forge" | "anvil"): string {
  const ancestorHomes: string[] = [];
  for (let directory = process.cwd(); ; directory = dirname(directory)) {
    ancestorHomes.push(join(directory, ".foundry/bin", name));
    if (dirname(directory) === directory) break;
  }
  const candidates = [
    process.env.FOUNDRY_BIN ? join(process.env.FOUNDRY_BIN, name) : "",
    join(userInfo().homedir, ".foundry/bin", name),
    process.env.HOME ? join(process.env.HOME, ".foundry/bin", name) : "",
    ...ancestorHomes,
    name,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate === name) return candidate;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next conventional location.
    }
  }
  return name;
}

function compileReference(forge: string): void {
  const result = spawnSync(forge, ["build", "--quiet"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.error) throw new Error(`cannot run forge: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`forge build failed: ${result.stderr || result.stdout}`);
}

async function waitForAnvil(process: ChildProcess): Promise<void> {
  let stderr = "";
  process.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`anvil exited early: ${stderr.trim()}`);
    try {
      const response = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (response.ok) return;
    } catch {
      // Anvil may still be binding the socket.
    }
    await delay(100);
  }
  throw new Error(`anvil did not become ready: ${stderr.trim()}`);
}
