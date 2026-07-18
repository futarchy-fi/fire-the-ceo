import { useCallback, useEffect, useMemo, useState } from 'react'
import { maxUint256, parseUnits, zeroAddress, type Hash } from 'viem'
import { useAccount, useReadContract, useSignTypedData, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import type { BoardRow } from '../lib/board.ts'
import { ADDR, RELAY_URL } from '../lib/config.ts'
import { erc20Abi, exchangeAbi } from '../lib/v2Abi.ts'
import { orderPrice, orderShares, orderToJson, orderTypes, parseStoredOrder, type Order, type SignedOrder, type StoredOrder } from '../lib/orders.ts'

function randomSalt(): bigint {
  const values = crypto.getRandomValues(new Uint32Array(8))
  return values.reduce((salt, value) => (salt << 32n) | BigInt(value), 0n)
}

function readDecimal(value: string): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function OrderBook({ row, kind }: { row: BoardRow; kind: 0 | 1 | 2 }) {
  const { address, isConnected } = useAccount()
  const [longSide, setLongSide] = useState(true)
  const [side, setSide] = useState<0 | 1>(0)
  const [priceText, setPriceText] = useState('0.50')
  const [sizeText, setSizeText] = useState('100')
  const [book, setBook] = useState<StoredOrder[]>([])
  const [mine, setMine] = useState<StoredOrder[]>([])
  const [status, setStatus] = useState<string>()
  const [txHash, setTxHash] = useState<Hash>()
  const tokenId = BigInt(row.id * 6 + kind * 2 + (longSide ? 0 : 1))
  const { signTypedDataAsync, isPending: signing } = useSignTypedData()
  const { writeContractAsync, isPending: writing } = useWriteContract()
  const receipt = useWaitForTransactionReceipt({ hash: txHash })
  const nonce = useReadContract({ address: ADDR.exchange, abi: exchangeAbi, functionName: 'nonces', args: address ? [address] : undefined, query: { enabled: Boolean(address) } })
  const allowance = useReadContract({ address: ADDR.pusd, abi: erc20Abi, functionName: 'allowance', args: address ? [address, ADDR.exchange] : undefined, query: { enabled: Boolean(address) } })

  const refresh = useCallback(async () => {
    try {
      const requests: Promise<Response>[] = [fetch(`${RELAY_URL}/book?tokenId=${tokenId}`)]
      if (address) requests.push(fetch(`${RELAY_URL}/orders?maker=${address}`))
      const responses = await Promise.all(requests)
      if (!responses[0].ok) throw new Error(`book HTTP ${responses[0].status}`)
      const bookPayload = await responses[0].json() as { orders?: unknown[] }
      setBook((bookPayload.orders ?? []).map(parseStoredOrder).filter((entry): entry is StoredOrder => entry !== null))
      if (responses[1]) {
        const minePayload = await responses[1].json() as { orders?: unknown[] }
        setMine((minePayload.orders ?? []).map(parseStoredOrder).filter((entry): entry is StoredOrder => entry !== null))
      } else setMine([])
    } catch { setStatus('Relay unavailable. The AMM estimate slider remains live.') }
  }, [address, tokenId])

  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 15_000); return () => window.clearInterval(timer) }, [refresh])
  useEffect(() => { if (receipt.isSuccess) { setStatus('Exchange transaction confirmed.'); setTxHash(undefined); void refresh() } }, [receipt.isSuccess, refresh])

  const amount = useMemo(() => {
    const price = Math.max(0.001, Math.min(0.999, readDecimal(priceText)))
    const size = Math.max(0, readDecimal(sizeText))
    const shares = parseUnits(size.toFixed(12), 18)
    const cash = parseUnits((size * price).toFixed(12), 18)
    return { price, size, shares, cash, makerAmount: side === 0 ? cash : shares, takerAmount: side === 0 ? shares : cash }
  }, [priceText, side, sizeText])
  const approvalNeeded = side === 0 && (allowance.data ?? 0n) < amount.cash

  const place = async () => {
    if (!address || amount.makerAmount === 0n || amount.takerAmount === 0n || nonce.data === undefined) return
    try {
      if (approvalNeeded) {
        const hash = await writeContractAsync({ address: ADDR.pusd, abi: erc20Abi, functionName: 'approve', args: [ADDR.exchange, maxUint256] })
        setTxHash(hash); setStatus('Exchange approval pending. Place the order after confirmation.'); return
      }
      const order: Order = {
        salt: randomSalt(), maker: address, signer: address, taker: zeroAddress, tokenId,
        makerAmount: amount.makerAmount, takerAmount: amount.takerAmount,
        expiration: BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60), nonce: nonce.data,
        feeRateBps: 0n, side, signatureType: 0,
      }
      const signature = await signTypedDataAsync({
        domain: { name: 'FireTheCEO Exchange', version: '1', chainId: ADDR.chainId, verifyingContract: ADDR.exchange },
        types: orderTypes, primaryType: 'Order', message: order,
      })
      const signed: SignedOrder = { ...order, signature }
      const response = await fetch(`${RELAY_URL}/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(orderToJson(signed)) })
      const payload = await response.json() as { message?: string }
      if (!response.ok) throw new Error(payload.message ?? `relay HTTP ${response.status}`)
      setStatus('Limit order signed and admitted by the relay. Funds remain in your wallet until fill.')
      await refresh()
    } catch (error) { setStatus(error instanceof Error ? `Order stopped: ${error.message}` : 'Order stopped.') }
  }

  const cancel = async (entry: StoredOrder) => {
    try {
      const order = entry.order
      const hash = await writeContractAsync({ address: ADDR.exchange, abi: exchangeAbi, functionName: 'cancelOrder', args: [{ ...order, feeRateBps: BigInt(order.feeRateBps) }] })
      setTxHash(hash); setStatus('Cancellation pending on Sepolia…')
    } catch (error) { setStatus(error instanceof Error ? `Cancellation stopped: ${error.message.split('\n')[0]}` : 'Cancellation stopped.') }
  }

  const bids = book.filter((entry) => entry.order.side === 0)
  const asks = book.filter((entry) => entry.order.side === 1)
  const myTokenOrders = mine.filter((entry) => entry.order.tokenId === tokenId)
  const exposure = kind === 2 ? (longSide ? 'CEO leaves' : 'CEO stays') : (longSide ? 'higher settlement' : 'lower settlement')

  return (
    <details className="order-book">
      <summary>Limit orders · CLOB book</summary>
      <div className="book-head"><div><span>Exposure token</span><strong>{exposure}</strong></div><div className="segmented"><button type="button" className={longSide ? 'selected' : ''} onClick={() => setLongSide(true)}>{kind === 2 ? 'Leaves' : 'Higher'}</button><button type="button" className={!longSide ? 'selected' : ''} onClick={() => setLongSide(false)}>{kind === 2 ? 'Stays' : 'Lower'}</button></div></div>
      <div className="book-grid">
        <div><p className="eyebrow">BIDS</p>{bids.length ? bids.slice(0, 8).map((entry) => <p key={entry.hash}><span>{orderPrice(entry.order).toFixed(3)}</span><span>{(orderShares(entry) / 1e18).toFixed(2)}</span></p>) : <small>No resting bids.</small>}</div>
        <div><p className="eyebrow">ASKS</p>{asks.length ? asks.slice(0, 8).map((entry) => <p key={entry.hash}><span>{orderPrice(entry.order).toFixed(3)}</span><span>{(orderShares(entry) / 1e18).toFixed(2)}</span></p>) : <small>No resting asks.</small>}</div>
      </div>
      <div className="limit-ticket">
        <div className="segmented"><button type="button" className={side === 0 ? 'selected' : ''} onClick={() => setSide(0)}>Bid</button><button type="button" className={side === 1 ? 'selected' : ''} onClick={() => setSide(1)}>Ask</button></div>
        <label>Limit price<input inputMode="decimal" value={priceText} onChange={(event) => setPriceText(event.target.value)} /></label>
        <label>Shares<input inputMode="decimal" value={sizeText} onChange={(event) => setSizeText(event.target.value)} /></label>
        {isConnected ? <button className="primary-action" type="button" disabled={signing || writing || amount.size <= 0} onClick={() => void place()}>{approvalNeeded ? 'Approve exchange' : `Sign ${side === 0 ? 'bid' : 'ask'} · ${amount.price.toFixed(3)}`}</button> : <p className="ticket-hint">Connect a wallet to sign a limit order.</p>}
      </div>
      {myTokenOrders.length ? <div className="my-orders"><p className="eyebrow">MY OPEN ORDERS</p>{myTokenOrders.map((entry) => <div key={entry.hash}><span>{entry.order.side === 0 ? 'BID' : 'ASK'} · {orderPrice(entry.order).toFixed(3)} · {(orderShares(entry) / 1e18).toFixed(2)} shares</span><button type="button" onClick={() => void cancel(entry)}>Cancel on-chain</button></div>)}</div> : null}
      {status ? <div className="toast" role="status">{status}</div> : null}
    </details>
  )
}
