import { useEffect, useMemo, useState } from 'react'
import { formatUnits, maxUint256, parseUnits, type Abi, type Hash } from 'viem'
import { useAccount, useChainId, useReadContract, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import fireAbiJson from '../lib/abi/FireTheCEO.json'
import pusdAbiJson from '../lib/abi/PlayUSD.json'
import { ADDR, CHAIN } from '../lib/config.ts'
import type { BoardRow } from '../lib/board.ts'

const FIRE_ABI = fireAbiJson as Abi
const PUSD_ABI = pusdAbiJson as Abi
const MARKETS = ['OUT', 'STAY', 'EXIT'] as const

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [delay, value])
  return debounced
}

function readShares(value: string): bigint {
  try { return value.trim() ? parseUnits(value, 18) : 0n } catch { return 0n }
}

export function TradePanel({ row }: { row: BoardRow }) {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const { switchChainAsync } = useSwitchChain()
  const [kind, setKind] = useState(0)
  const [longSide, setLongSide] = useState(true)
  const [action, setAction] = useState<'buy' | 'sell'>('buy')
  const [sharesText, setSharesText] = useState('100')
  const [txHash, setTxHash] = useState<Hash>()
  const [toast, setToast] = useState<string>()
  const debouncedText = useDebounced(sharesText, 300)
  const shares = useMemo(() => readShares(debouncedText), [debouncedText])
  const { writeContractAsync, isPending: walletPending } = useWriteContract()
  const receipt = useWaitForTransactionReceipt({ hash: txHash })
  const allowance = useReadContract({
    address: ADDR.pusd, abi: PUSD_ABI, functionName: 'allowance',
    args: address ? [address, ADDR.fireTheCeo] : undefined,
    query: { enabled: Boolean(address), refetchInterval: 15_000 },
  })
  const quote = useReadContract({
    address: ADDR.fireTheCeo,
    abi: FIRE_ABI,
    functionName: action === 'buy' ? 'quoteBuy' : 'quoteSell',
    args: [BigInt(row.id), kind, longSide, shares],
    query: { enabled: shares > 0n, refetchInterval: 15_000 },
  })
  const quoteValue = quote.data as bigint | undefined
  const allowanceValue = (allowance.data as bigint | undefined) ?? 0n
  const approvalNeeded = action === 'buy' && quoteValue !== undefined && allowanceValue < quoteValue
  const isClosed = row.state !== 0

  useEffect(() => {
    if (receipt.isSuccess) {
      setToast('Confirmed on Sepolia.')
      setTxHash(undefined)
      void allowance.refetch()
    }
    if (receipt.isError) { setToast('The transaction failed on Sepolia. Review the wallet error and try again.'); setTxHash(undefined) }
  }, [allowance, receipt.isError, receipt.isSuccess])

  const submit = async () => {
    if (!address || !quoteValue || shares <= 0n) return
    try {
      if (chainId !== CHAIN.id) await switchChainAsync({ chainId: CHAIN.id })
      setToast('Confirm the order in your wallet.')
      let hash: Hash
      if (approvalNeeded) {
        hash = await writeContractAsync({ address: ADDR.pusd, abi: PUSD_ABI, functionName: 'approve', args: [ADDR.fireTheCeo, maxUint256] })
        setToast('Approval pending on Sepolia.')
      } else if (action === 'buy') {
        const maxCost = (quoteValue * 101n + 99n) / 100n
        hash = await writeContractAsync({ address: ADDR.fireTheCeo, abi: FIRE_ABI, functionName: 'buy', args: [BigInt(row.id), kind, longSide, shares, maxCost] })
        setToast('Buy pending on Sepolia.')
      } else {
        const minProceeds = quoteValue * 99n / 100n
        hash = await writeContractAsync({ address: ADDR.fireTheCeo, abi: FIRE_ABI, functionName: 'sell', args: [BigInt(row.id), kind, longSide, shares, minProceeds] })
        setToast('Sale pending; proceeds will remain in escrow.')
      }
      setTxHash(hash)
    } catch (error) {
      setToast(error instanceof Error ? `Wallet action stopped: ${error.message.split('\n')[0]}` : 'Wallet action stopped. Try again.')
    }
  }
  const quoteText = quoteValue === undefined ? '—' : Number(formatUnits(quoteValue, 18)).toLocaleString('en-US', { maximumFractionDigits: 4 })
  const sideName = `${MARKETS[kind]}-${longSide ? 'LONG' : 'SHORT'}`
  const stateText = row.state === 1 ? 'Trading closed. Awaiting the settlement read.' : row.state === 2 ? 'Resolved. The 48-hour dispute window is open.' : row.state === 3 ? 'Resolved and claimable. Use the positions filing below.' : ''

  return (
    <section className="order-ticket" aria-labelledby="trade-heading">
      <p className="eyebrow">ORDER TICKET · 1% SLIPPAGE LIMIT</p>
      <h2 id="trade-heading">Trade this finding</h2>
      {isClosed ? <div className="ticket-state"><strong>{row.state === 3 ? 'CLAIM' : 'WATCH'}</strong> {stateText}</div> : <>
        <div className="segmented" aria-label="Order action">
          <button type="button" className={action === 'buy' ? 'selected' : ''} onClick={() => setAction('buy')}>Buy</button>
          <button type="button" className={action === 'sell' ? 'selected' : ''} onClick={() => setAction('sell')}>Sell</button>
        </div>
        <label>Market<select value={kind} onChange={(event) => setKind(Number(event.target.value))}>{MARKETS.map((market, index) => <option key={market} value={index}>{market}</option>)}</select></label>
        <label>Side<select value={longSide ? 'long' : 'short'} onChange={(event) => setLongSide(event.target.value === 'long')}><option value="long">LONG</option><option value="short">SHORT</option></select></label>
        <label>Shares<input inputMode="decimal" value={sharesText} onChange={(event) => setSharesText(event.target.value)} aria-invalid={shares <= 0n} /></label>
        <div className="ticket-quote"><span>{action === 'buy' ? 'Live cost' : 'Escrowed proceeds'}</span><strong>{quote.isFetching ? 'Quoting…' : `${quoteText} pUSD`}</strong></div>
        {quote.error ? <p className="field-error">Quote unavailable. The market may be closed or the share amount is outside its limit.</p> : null}
        {!isConnected ? <p className="ticket-hint">Connect a wallet to file an order.</p> : (
          <button type="button" className="primary-action" disabled={!quoteValue || walletPending || receipt.isLoading} onClick={() => void submit()}>
            {approvalNeeded ? 'Approve pUSD · then trade' : action === 'buy' ? `Buy ${sharesText || '0'} ${sideName} · ≈ ${quoteText} pUSD` : `Sell ${sharesText || '0'} ${sideName} · escrow ≈ ${quoteText} pUSD`}
          </button>
        )}
        {action === 'sell' ? <p className="ticket-hint">Escrow sale proceeds. Cash remains in the contract until resolution. Voided trades refund paid-in cash.</p> : null}
      </>}
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </section>
  )
}
