import { useEffect, useMemo, useState } from 'react'
import { maxUint256, parseUnits, type Hash } from 'viem'
import { useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { useBoard, type BoardRow } from '../lib/board.ts'
import { ADDR } from '../lib/config.ts'
import { coreAbi, erc20Abi } from '../lib/v2Abi.ts'
import type { LmsrMarket } from '../components/EstimateSlider.tsx'

const WAD = 1e18

function cost(qL: number, qS: number, b: number): number {
  const high = Math.max(qL, qS)
  return high + b * Math.log(Math.exp((qL - high) / b) + Math.exp((qS - high) / b))
}

function consumed(markets: readonly LmsrMarket[], scale: number): number {
  return markets.reduce((sum, market) => {
    const qL = Number(market.qL) / WAD, qS = Number(market.qS) / WAD, b = Number(market.b) / WAD
    return sum + cost(qL, qS, b * scale) - cost(qL, qS, b)
  }, 0)
}

function boostedBs(markets: readonly LmsrMarket[], payment: number): readonly [bigint, bigint, bigint] {
  const target = payment * 0.8
  let low = 1, high = 2
  while (consumed(markets, high) < target && high < 1_000_000) high *= 2
  for (let index = 0; index < 64; index += 1) {
    const middle = (low + high) / 2
    if (consumed(markets, middle) < target) low = middle
    else high = middle
  }
  return markets.map((market) => BigInt(Math.ceil(Number(market.b) * high))) as unknown as readonly [bigint, bigint, bigint]
}

function BoostForm({ row }: { row: BoardRow }) {
  const [paymentText, setPaymentText] = useState('100')
  const [status, setStatus] = useState<string>()
  const [txHash, setTxHash] = useState<Hash>()
  const { address, isConnected } = useAccount()
  const { writeContractAsync, isPending } = useWriteContract()
  const receipt = useWaitForTransactionReceipt({ hash: txHash })
  const marketRead = useReadContract({ address: ADDR.core, abi: coreAbi, functionName: 'getMarkets', args: [BigInt(row.id)] })
  const markets = marketRead.data as readonly LmsrMarket[] | undefined
  const payment = Math.max(0, Number(paymentText) || 0)
  const paymentWad = parseUnits(payment.toFixed(12), 18)
  const newBs = useMemo(() => markets && payment > 0 ? boostedBs(markets, payment) : null, [markets, payment])
  const allowance = useReadContract({ address: ADDR.pusd, abi: erc20Abi, functionName: 'allowance', args: address ? [address, ADDR.core] : undefined, query: { enabled: Boolean(address) } })
  const approvalNeeded = (allowance.data ?? 0n) < paymentWad
  useEffect(() => { if (receipt.isSuccess) { setStatus('Liquidity proposal confirmed on Sepolia.'); setTxHash(undefined) } }, [receipt.isSuccess])
  const submit = async () => {
    if (!newBs) return
    try {
      const hash = approvalNeeded
        ? await writeContractAsync({ address: ADDR.pusd, abi: erc20Abi, functionName: 'approve', args: [ADDR.core, maxUint256] })
        : await writeContractAsync({ address: ADDR.core, abi: coreAbi, functionName: 'proposeBoost', args: [BigInt(row.id), paymentWad, newBs] })
      setTxHash(hash); setStatus(approvalNeeded ? 'Core approval pending. Propose again after confirmation.' : 'Liquidity proposal pending…')
    } catch (error) { setStatus(error instanceof Error ? `Proposal stopped: ${error.message.split('\n')[0]}` : 'Proposal stopped.') }
  }
  return (
    <section className="boost-form">
      <p className="eyebrow">SELECTED FILING · {row.ticker}</p><h2>Propose liquidity for {row.name}</h2>
      <label><span>Payment</span><span><input value={paymentText} inputMode="decimal" onChange={(event) => setPaymentText(event.target.value)} /> pUSD</span></label>
      <div className="boost-allocation"><div><span>Curve funding · 80%</span><strong>{(payment * 0.8).toFixed(2)} pUSD</strong></div><div><span>Docket reward pool · 20%</span><strong>{(payment * 0.2).toFixed(2)} pUSD</strong></div></div>
      <table><thead><tr><th>Market</th><th>Current b</th><th>Resulting b</th></tr></thead><tbody>{markets?.map((market, kind) => <tr key={kind}><td>{['CEO leaves', 'CEO stays', 'Departure chance'][kind]}</td><td>{(Number(market.b) / WAD).toFixed(2)}</td><td>{newBs ? (Number(newBs[kind]) / WAD).toFixed(2) : '—'}</td></tr>)}</tbody></table>
      <p className="reward-rule"><strong>Reward rule, without euphemism:</strong> score = payment × max(0, final seven-day time-averaged premium − recorded baseline). The reward pool is split by score, each reward is capped at 3× that proposal’s effective payment, and a proposal can earn zero.</p>
      {isConnected ? <button className="primary-action" type="button" disabled={isPending || !newBs || payment <= 0} onClick={() => void submit()}>{approvalNeeded ? 'Approve pUSD · then propose' : `Propose ${payment.toFixed(2)} pUSD of liquidity`}</button> : <p className="ticket-hint">Connect a wallet to propose liquidity.</p>}
      {status ? <div className="toast" role="status">{status}</div> : null}
    </section>
  )
}

export function LiquidityPage() {
  const { rows, error } = useBoard()
  const [selectedId, setSelectedId] = useState<number>()
  const selected = rows?.find((row) => row.id === selectedId) ?? rows?.[0]
  return <main className="page-shell liquidity-page"><header className="filing-header"><p className="eyebrow">FORM FTC-DKT · ROBIN’S DOCKET AUCTION</p><h1>Propose liquidity</h1><p className="lede">Pay to deepen one company’s three market curves. Most of the payment increases `b`; the rest enters a competitive reward pool for useful surprise.</p></header>{!ADDR.isV2 ? <section className="notice">The fallback deployment has no V2 docket. This filing becomes active when `deployment-v2.json` supplies separate core and exchange addresses.</section> : null}{error ? <section className="notice">The company register could not be read.</section> : null}<div className="liquidity-layout"><aside><label htmlFor="company-boost">Company filing</label><select id="company-boost" value={selected?.id ?? ''} onChange={(event) => setSelectedId(Number(event.target.value))}>{rows?.map((row) => <option key={row.id} value={row.id}>{row.ticker} · {row.name}</option>)}</select><p>Increasing `b` makes the curve deeper: a larger informed trade is required to move the displayed estimate by the same distance.</p></aside>{selected && ADDR.isV2 ? <BoostForm row={selected} /> : <p>{ADDR.isV2 ? 'Reading the docket…' : 'V2 docket unavailable on the fallback deployment.'}</p>}</div></main>
}
