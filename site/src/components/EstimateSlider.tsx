import { useEffect, useMemo, useState } from 'react'
import { formatUnits, maxUint256, parseUnits, type Hash } from 'viem'
import { useAccount, useChainId, useReadContract, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import type { BoardRow } from '../lib/board.ts'
import { ADDR, CHAIN } from '../lib/config.ts'
import { coreAbi, erc20Abi } from '../lib/v2Abi.ts'
import { usd } from '../lib/format.ts'

export type LmsrMarket = { qL: bigint; qS: bigint; b: bigint }

const WAD = 1e18
const clampProbability = (value: number) => Math.max(0.001, Math.min(0.999, value))
const logit = (value: number) => Math.log(value / (1 - value))

function stableCost(qL: number, qS: number, b: number): number {
  const high = Math.max(qL, qS)
  return high + b * Math.log(Math.exp((qL - high) / b) + Math.exp((qS - high) / b))
}

function buyCost(market: LmsrMarket, longSide: boolean, shares: number): number {
  const qL = Number(market.qL) / WAD
  const qS = Number(market.qS) / WAD
  const b = Number(market.b) / WAD
  return stableCost(qL + (longSide ? shares : 0), qS + (longSide ? 0 : shares), b) - stableCost(qL, qS, b)
}

function cappedShares(market: LmsrMarket, longSide: boolean, wanted: number, budget: number): number {
  if (wanted <= 0 || budget <= 0) return 0
  if (buyCost(market, longSide, wanted) <= budget) return wanted
  let low = 0
  let high = wanted
  for (let index = 0; index < 48; index += 1) {
    const middle = (low + high) / 2
    if (buyCost(market, longSide, middle) <= budget) low = middle
    else high = middle
  }
  return low
}

export function EstimateSlider({ row, kind, market, currentMid }: { row: BoardRow; kind: 0 | 1; market: LmsrMarket; currentMid: number }) {
  const floor = row.chain.floorCents / 100
  const cap = row.chain.capCents / 100
  const current = floor + currentMid * (cap - floor)
  const [target, setTarget] = useState(current)
  const [budgetText, setBudgetText] = useState('25')
  const [txHash, setTxHash] = useState<Hash>()
  const [status, setStatus] = useState<string>()
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync, isPending } = useWriteContract()
  const receipt = useWaitForTransactionReceipt({ hash: txHash })

  useEffect(() => setTarget(current), [current])
  useEffect(() => {
    if (receipt.isSuccess) { setStatus('Estimate filed on Sepolia.'); setTxHash(undefined) }
    if (receipt.isError) { setStatus('The transaction failed. No estimate was filed.'); setTxHash(undefined) }
  }, [receipt.isError, receipt.isSuccess])

  const plan = useMemo(() => {
    const targetMid = clampProbability((target - floor) / (cap - floor || 1))
    const b = Number(market.b) / WAD
    const delta = b * (logit(targetMid) - logit(clampProbability(currentMid)))
    const longSide = delta >= 0
    const budget = Number(budgetText)
    const shares = cappedShares(market, longSide, Math.abs(delta), Number.isFinite(budget) ? budget : 0)
    const reachedDelta = shares * (longSide ? 1 : -1)
    const reachedMid = 1 / (1 + Math.exp(-(logit(clampProbability(currentMid)) + reachedDelta / b)))
    return { targetMid, longSide, shares, reached: floor + reachedMid * (cap - floor), capped: shares + 1e-7 < Math.abs(delta) }
  }, [budgetText, cap, currentMid, floor, market, target])
  const sharesWad = useMemo(() => parseUnits(Math.max(0, plan.shares).toFixed(12), 18), [plan.shares])
  const quote = useReadContract({
    address: ADDR.core, abi: coreAbi, functionName: 'quoteBuy',
    args: [BigInt(row.id), kind, plan.longSide, sharesWad],
    query: { enabled: sharesWad > 0n },
  })
  const quoteValue = quote.data
  const allowance = useReadContract({
    address: ADDR.pusd, abi: erc20Abi, functionName: 'allowance',
    args: address ? [address, ADDR.core] : undefined,
    query: { enabled: Boolean(address) },
  })
  const approvalNeeded = quoteValue !== undefined && (allowance.data ?? 0n) < quoteValue

  const submit = async () => {
    if (!address || !quoteValue || sharesWad === 0n) return
    try {
      if (chainId !== CHAIN.id) await switchChainAsync({ chainId: CHAIN.id })
      const hash = approvalNeeded
        ? await writeContractAsync({ address: ADDR.pusd, abi: erc20Abi, functionName: 'approve', args: [ADDR.core, maxUint256] })
        : await writeContractAsync({ address: ADDR.core, abi: coreAbi, functionName: 'buy', args: [BigInt(row.id), kind, plan.longSide, sharesWad, (quoteValue * 101n + 99n) / 100n] })
      setStatus(approvalNeeded ? 'Approval submitted. Return here to file the estimate.' : 'Estimate pending on Sepolia…')
      setTxHash(hash)
    } catch (error) {
      setStatus(error instanceof Error ? `Wallet stopped: ${error.message.split('\n')[0]}` : 'Wallet stopped.')
    }
  }

  return (
    <div className="estimate-control">
      <div className="estimate-readout"><span>Your estimate</span><strong>{usd.format(target)}</strong><small>{target >= current ? '↑ Higher than the market' : '↓ Lower than the market'}</small></div>
      <input className="estimate-slider" type="range" min={floor} max={cap} step="0.01" value={target} onChange={(event) => setTarget(Number(event.target.value))} aria-label="Predicted settlement price" />
      <div className="estimate-market-pin" style={{ left: `${currentMid * 100}%` }}><i />Market {usd.format(current)}</div>
      <label className="budget-field"><span>Maximum budget</span><span><input inputMode="decimal" value={budgetText} onChange={(event) => setBudgetText(event.target.value)} /> pUSD</span></label>
      <p className="plain-receipt">You buy {plan.shares.toLocaleString('en-US', { maximumFractionDigits: 2 })} shares of {plan.longSide ? 'higher' : 'lower'} exposure; the curve reaches {usd.format(plan.reached)}{plan.capped ? ' at your budget cap' : ''}. Live quote: {quoteValue === undefined ? '—' : `${Number(formatUnits(quoteValue, 18)).toFixed(2)} pUSD`}.</p>
      {!isConnected ? <p className="ticket-hint">Connect a wallet to file this estimate.</p> : <button className="primary-action" type="button" disabled={isPending || receipt.isLoading || !quoteValue || row.state !== 0} onClick={() => void submit()}>{approvalNeeded ? 'Approve pUSD · then file estimate' : `Move market toward ${usd.format(plan.reached)}`}</button>}
      {status ? <div className="toast" role="status">{status}</div> : null}
    </div>
  )
}
