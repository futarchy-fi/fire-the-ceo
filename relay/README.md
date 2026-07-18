# FireTheCEO open order relay

A small, non-custodial order relay and optional permissionless matcher for the
FireTheCEO and futarchy.fi exchanges. It stores signed EIP-712 orders, serves a
price-time ordered book, mirrors fills over WebSocket, and periodically snapshots
the in-memory book to JSON. There is no database and no HTTP framework.

Anyone can run this. Relays need only an RPC endpoint. Matchers additionally need a
funded key for gas. Neither role has special contract permissions.

## Trust model

The relay cannot transfer, escrow, or spend user funds. It only stores signatures and
reads chain state. Every fill is checked and settled by the exchange contract, which is
the sole source of truth for balances, allowances, nonces, cancellations, expirations,
market state, fill ratios, and prices.

A relay can censor, delay, reorder, or disappear. The escape hatch is to send a valid
`fillOrder`, `matchOrders`, or `fillWithAmm` transaction directly to the permissionless
exchange contract, or use another relay/matcher. Never give a relay a private key.

The optional matcher is just one public participant. Its key can only act as that
account and pay gas; it has no operator role.

## Run locally

Requirements: Node-compatible Bun and an RPC endpoint. The repository uses
`/home/kelvin/.bun/bin/bun` in this workspace.

```sh
cd relay
/home/kelvin/.bun/bin/bun install

export RPC_URL=https://your-rpc.example
export EXCHANGE_ADDR=0xYourExchange
export CHAIN_ID=11155111
export PORT=8080
export EXCHANGE_KIND=ceo

/home/kelvin/.bun/bin/bun run relay
```

For futarchy.fi's wrapped ERC-20 markets, set `EXCHANGE_KIND=erc20` and
`EXCHANGE_NAME="Futarchy Exchange"`.

Run a matcher in another terminal:

```sh
export RPC_URL=https://your-rpc.example
export EXCHANGE_ADDR=0xYourExchange
export CHAIN_ID=11155111
export EXCHANGE_KIND=ceo
export RELAY_WS_URL=ws://127.0.0.1:8080/ws
export MATCHER_PRIVATE_KEY=0xYourFundedKey
export EXCHANGE_HAS_AMM=true

/home/kelvin/.bun/bin/bun run matcher
```

`EXCHANGE_HAS_AMM=false` is the book-only mode for futarchy.fi. The CEO matcher handles
COMPLEMENTARY crosses plus complementary-token BUY/BUY (MINT) and SELL/SELL (MERGE)
crosses. With AMM mode enabled, it reads the CEO market's `qL`, `qS`, and `b`, then caps
each curve leg at `dq = b * (logit(limitPrice) - logit(currentPrice))` (sign-adjusted for
sells).

## Docker Compose

Copy `.env.example` to `.env`, fill in real values, then run the relay:

```sh
docker compose up --build relay
```

Start both services, including the optional matcher profile:

```sh
docker compose --profile matcher up --build
```

The relay snapshot is retained in the `relay-data` named volume.

## Configuration

Relay variables:

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `RPC_URL` | yes | — | JSON-RPC HTTP URL |
| `EXCHANGE_ADDR` | yes | — | Settlement exchange address |
| `CHAIN_ID` | yes | — | EIP-712 and RPC chain ID |
| `PORT` | no | `8080` | HTTP and WebSocket port |
| `EXCHANGE_KIND` | no | `ceo` | `ceo` or `erc20` validation adapter |
| `EXCHANGE_NAME` | no | kind-specific | `FireTheCEO Exchange` or `Futarchy Exchange` |
| `SNAPSHOT_PATH` | no | `./data/orders.json` | Periodic JSON snapshot path |
| `POLL_INTERVAL_MS` | no | `4000` | Chain log/status polling interval |
| `SNAPSHOT_INTERVAL_MS` | no | `10000` | Snapshot interval |

Matcher variables add:

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `MATCHER_PRIVATE_KEY` | yes | — | Funded 32-byte transaction key |
| `RELAY_WS_URL` | no | `ws://relay:8080/ws` | Relay WebSocket endpoint |
| `EXCHANGE_HAS_AMM` | no | `false` | Enable CEO LMSR matching |
| `AMM_MAX_SHARES` | no | `uint128.max` | Per-transaction AMM share cap |
| `MATCHER_RETRY_MS` | no | `4000` | Reconnect and pending-order delay |

## Order JSON

`POST /orders` accepts either a flat signed order or `{ "order": {...}, "signature":
"0x..." }`. Integer values should be decimal strings. The signed type is exactly:

```text
Order(uint256 salt,address maker,address signer,address taker,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,uint256 feeRateBps,uint8 side,uint8 signatureType)
```

Example shape:

```json
{
  "salt": "42",
  "maker": "0x...",
  "signer": "0x...",
  "taker": "0x0000000000000000000000000000000000000000",
  "tokenId": "17",
  "makerAmount": "350000000000000000",
  "takerAmount": "1000000000000000000",
  "expiration": "2000000000",
  "nonce": "0",
  "feeRateBps": "0",
  "side": 0,
  "signatureType": 0,
  "signature": "0x..."
}
```

The relay accepts signature types `0` (EOA) and `3` (EIP-1271). For safety, `maker`
must equal `signer`; EOA signatures are recovered from the typed-data digest and EIP-1271
signatures are checked through `isValidSignature(bytes32,bytes)`.

## HTTP and WebSocket API

- `POST /orders` — validates syntax, signature, expiry, nonce/order status, registered/open
  market, and the maker's live balance and allowance. Returns `201` when stored, `200` for
  an already stored valid order, or `422` with a stable error code for chain validation
  failures.
- `GET /book?tokenId=17` — returns BUYs best-to-worst, followed by SELLs best-to-worst;
  equal prices use arrival order.
- `GET /orders?maker=0x...` — returns active orders for one maker.
- `GET /health` — returns `200` when chain polling is healthy or `503` with the last RPC
  error. It includes the last scanned block and book/client counts.
- `GET /ws` (WebSocket upgrade) — first sends `{type:"snapshot", orders:[...]}`. Later
  messages are `{type:"book_delta", action:"add|update|remove", ...}` and
  `{type:"fill", orderHash, blockNumber, transactionHash, data}`.

JSON responses encode all uint256 values as decimal strings.

## Chain interfaces

All contract ABIs are isolated in `src/exchange.ts`. `EXCHANGE_ADDR` is the settlement
module (`FireTheCEOExchangeV2`), not the market core. The CEO adapter reads
`orderStatus(bytes32)`, `nonces(address)`, and `paused()` from the exchange, follows its
immutable `core()` address, and reads `companyCount`, `getCompany`, `getMarkets`, `pusd`,
and `positions` from that core. CEO collateral allowance is correctly checked against the
core, which performs `transferFrom` during settlement.

The wrapped-token adapter expects `collateralForToken(uint256)` and
`isMarketOpen(uint256)` on its exchange, then reads standard ERC-20 `balanceOf` and
`allowance`. The matcher targets the FireTheCEO V2 calls:

```text
matchOrders(Order takerOrder, Order[] makerOrders,
            uint256 takerFillAmount, uint256[] makerFillAmounts)
fillWithAmm(Order takerOrder, Order[] makerOrders,
            uint256 takerFillAmount, uint256[] makerFillAmounts,
            uint256 ammMaxShares)
```

`Order` in calldata includes trailing `bytes signature`; the signature remains excluded
from its EIP-712 hash. The relay recognizes the V2
`OrderFilled(bytes32,address,address,uint256,uint8,uint256,uint256,uint256)` event and a
pair of legacy-compatible payloads. If another settlement implementation chooses
different getters or events, only `src/exchange.ts` needs an adapter update.

## Self-check

The check requires Foundry (`forge` and `anvil`) plus Bun. It compiles and deploys a
minimal Solidity reference hasher on local Anvil, checks the fixed digest vector against
`src/order.ts`, recovers an EOA signature, rejects a mutated order, signs and stores two
crossing orders, and asserts matcher sizing.

```sh
/home/kelvin/.bun/bin/bun run self-check
/home/kelvin/.bun/bin/bun run typecheck
```

Expected output includes:

```text
PASS EIP-712 hash: 0x0ab0a3d9151bc4d0c425befbdb626f80270eb574472cb5644f25e8b98d106e2c
PASS EOA signature recovery and mutation rejection
PASS relay book storage and signed COMPLEMENTARY/MINT cross matching
PASS Solidity reference on Anvil chain 31337
```

## Known adapter deviation

FireTheCEO V2's concrete source is present at
`contracts/src/v2/FireTheCEOv2.sol` and the CEO adapter matches it. The frozen shared spec
does not define concrete getter names for futarchy.fi's registry, so the generic wrapped
ERC-20 adapter currently assumes `collateralForToken(uint256)` and
`isMarketOpen(uint256)`. If the futarchy.fi settlement PR uses different names, update
those two ABI calls in `src/exchange.ts`; order hashing and matcher behavior are shared.
