// Snapshot the FireTheCEO board: append full state to archive.jsonl and
// rewrite history.json (trailing 7d hourly, 4dp) for the site's sparklines.
import { createPublicClient, http, fallback } from 'viem';
import { sepolia } from 'viem/chains';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// ponytail: charts now read the on-chain observation buffer directly; this snapshot is an
// optional cache only. Prefer V2 core, fall back to V1.
let DEPLOY;
try { DEPLOY = JSON.parse(readFileSync(join(HERE, '../data/deployment-v2.json'), 'utf8')); }
catch { DEPLOY = JSON.parse(readFileSync(join(HERE, '../data/deployment.json'), 'utf8')); }
DEPLOY.fireTheCeo = DEPLOY.core ?? DEPLOY.fireTheCeo;
const OUT_DIR = process.env.CEO_DATA_DIR || '/home/kelvin/fleet/apps/ceo/data';
const ABI = JSON.parse(readFileSync(join(HERE, 'FireTheCEO.abi.json'), 'utf8'));

const client = createPublicClient({
  chain: sepolia,
  transport: fallback([
    http('https://ethereum-sepolia-rpc.publicnode.com'),
    http('https://sepolia.drpc.org'),
  ]),
});

const addr = DEPLOY.fireTheCeo;
const [midOut, midStay, pExit, state] = await client.readContract({
  address: addr, abi: ABI, functionName: 'getAllPrices',
});
const count = midOut.length;

// ticker cache: refresh only when company count changes
const cachePath = join(OUT_DIR, 'tickers.json');
let tickers = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : [];
if (tickers.length !== count) {
  tickers = [];
  for (let i = 0; i < count; i++) {
    const c = await client.readContract({ address: addr, abi: ABI, functionName: 'getCompany', args: [BigInt(i)] });
    tickers.push(c.ticker);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(tickers));
}

const f = (wad) => Math.round(Number(wad) / 1e14) / 1e4;
const t = Math.floor(Date.now() / 1000);
const rows = {};
for (let i = 0; i < count; i++) rows[tickers[i]] = [f(midOut[i]), f(midStay[i]), f(pExit[i]), Number(state[i])];

mkdirSync(OUT_DIR, { recursive: true });
appendFileSync(join(OUT_DIR, 'archive.jsonl'), JSON.stringify({ t, rows }) + '\n');

// history: trailing 7 days, 30-min buckets (matches timer cadence; ~336 pts)
const lines = readFileSync(join(OUT_DIR, 'archive.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const cutoff = t - 7 * 86400;
const byHour = new Map();
for (const s of lines) if (s.t >= cutoff) byHour.set(Math.floor(s.t / 1800), s);
const snapshots = [...byHour.values()].sort((a, b) => a.t - b.t);
writeFileSync(join(OUT_DIR, 'history.json'), JSON.stringify({ snapshots }));
console.log(`snapshot ok: ${count} companies, ${snapshots.length} history points`);
