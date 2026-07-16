import { useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useReadContract, useReadContracts } from 'wagmi'
import type { Abi } from 'viem'
import fireAbiJson from '../lib/abi/FireTheCEO.json'
import { ADDR } from '../lib/config.ts'
import { COMPANY_METADATA, fireSignal, normalizeCompany, registerTicker, useHistory, type BoardRow, type Prices } from '../lib/board.ts'
import { formatDate, percent, signedPercent, usd } from '../lib/format.ts'
import { SignalBadge } from '../components/Verdict.tsx'
import { PremiumChart } from '../components/PremiumChart.tsx'
import { ConditionalValueChart, DepartureProbabilityChart } from '../components/MarketHistoryCharts.tsx'
import { TradePanel } from '../components/TradePanel.tsx'
import { PositionsCard } from '../components/PositionsCard.tsx'

const FIRE_ABI = fireAbiJson as Abi
const WAD = 1e18
type Market = { qL: bigint; qS: bigint; b: bigint }

function rowFromChain(id: number, chain: NonNullable<ReturnType<typeof normalizeCompany>>, prices: Prices): BoardRow {
  registerTicker(id, chain.ticker)
  const metadata = COMPANY_METADATA[chain.ticker]
  const midOut = Number(prices[0][id]) / WAD
  const midStay = Number(prices[1][id]) / WAD
  const pExit = Number(prices[2][id]) / WAD
  const spot = chain.spotCents / 100
  const band = (chain.capCents - chain.floorCents) / 100
  const eOut = chain.floorCents / 100 + midOut * band
  const eStay = chain.floorCents / 100 + midStay * band
  return {
    id, ticker: chain.ticker, name: metadata?.name ?? chain.name, ceo: metadata?.ceo ?? chain.ceo,
    ceoSince: metadata?.ceoSince ?? 'test filing', sector: metadata?.sector ?? 'Test company', mcapB: metadata?.mcapB ?? 0,
    spot, midOut, midStay, pExit, premium: spot ? (eOut - eStay) / spot : 0, eOut, eStay,
    state: Number(prices[3][id]), note: metadata?.note, sourceUrl: metadata?.sourceUrl, chain,
  }
}

function marketLoss(market: Market): number {
  const qL = Number(market.qL) / WAD
  const qS = Number(market.qS) / WAD
  const b = Number(market.b) / WAD
  const m = Math.max(qL, qS)
  return m + b * Math.log(Math.exp((qL - m) / b) + Math.exp((qS - m) / b)) - Math.min(qL, qS)
}

function MarketCard({ title, qualifier, value, row }: { title: string; qualifier: string; value: string; row: BoardRow }) {
  return (
    <article className="market-card">
      <p className="eyebrow">{qualifier}</p>
      <h3>{title}</h3>
      <strong>{value}</strong>
      <span>{title === 'EXIT' ? 'Departure probability' : `Settlement band ${usd.format(row.chain.floorCents / 100)}–${usd.format(row.chain.capCents / 100)}`}</span>
    </article>
  )
}

export function CompanyPage() {
  const { ticker = '' } = useParams()
  const wanted = decodeURIComponent(ticker).toUpperCase()
  const history = useHistory()
  const pricesRead = useReadContract({ address: ADDR.fireTheCeo, abi: FIRE_ABI, functionName: 'getAllPrices', query: { refetchInterval: 30_000 } })
  const prices = pricesRead.data as Prices | undefined
  const ids = useMemo(() => Array.from({ length: prices?.[0].length ?? 0 }, (_, id) => id), [prices])
  const companies = useReadContracts({
    contracts: ids.map((id) => ({ address: ADDR.fireTheCeo, abi: FIRE_ABI, functionName: 'getCompany', args: [BigInt(id)] })),
    query: { enabled: ids.length > 0, refetchInterval: 30_000 },
  })
  const row = useMemo(() => {
    if (!prices || !companies.data) return null
    for (const [id, result] of companies.data.entries()) {
      if (result.status !== 'success') continue
      const chain = normalizeCompany(result.result)
      if (chain?.ticker.toUpperCase() === wanted) return rowFromChain(id, chain, prices)
    }
    return undefined
  }, [companies.data, prices, wanted])
  const markets = useReadContract({
    address: ADDR.fireTheCeo, abi: FIRE_ABI, functionName: 'getMarkets',
    args: row ? [BigInt(row.id)] : undefined, query: { enabled: Boolean(row) },
  })
  const subsidy = (markets.data as readonly Market[] | undefined)?.reduce((sum, market) => sum + marketLoss(market), 0)

  if (pricesRead.error || companies.error) return <main className="page-shell"><section className="notice" role="alert"><strong>RPC read failed.</strong><p>This company filing could not be read from Sepolia. Return to the board and retry.</p><Link to="/">Return to the board</Link></section></main>
  if (row === null) return <main className="page-shell"><p className="eyebrow">Reading company filing…</p></main>
  if (row === undefined) return <main className="page-shell prose-page"><p className="eyebrow">FILING NOT FOUND</p><h1>{wanted}</h1><p>No on-chain company uses this ticker.</p><Link to="/">Return to the board</Link></main>
  const verdict = history ? fireSignal(history, row.id) : 'WATCH'
  const stateLabel = ['TRADING', 'AWAITING', 'DISPUTABLE', 'CLAIMABLE'][row.state] ?? 'UNKNOWN'

  return (
    <main className="page-shell company-page">
      <Link className="back-link" to="/">← The board</Link>
      <header className="company-header">
        <div>
          <p className="eyebrow">IN RE: {row.name.toUpperCase()} — {row.ceo.toUpperCase()}, CHIEF EXECUTIVE</p>
          <h1>{row.ticker}</h1>
          <p className="company-subhead">Memo to the board · CEO since {row.ceoSince} · {row.sector}</p>
        </div>
        <div className="company-verdict"><SignalBadge verdict={verdict} large /><span>{verdict === 'WATCH' ? 'no signal — thin market' : 'trailing seven-day finding'}</span></div>
      </header>
      <section className="company-facts">
        <div><span>Fire premium</span><strong className={row.premium > 0 ? 'is-fire' : 'is-keep'}>{signedPercent(row.premium)}</strong></div>
        <div><span>Listing spot</span><strong>{usd.format(row.spot)}</strong></div>
        <div><span>Departure</span><strong>{percent(row.pExit)}</strong></div>
        <div><span>Docket state</span><strong>{stateLabel}</strong></div>
      </section>
      <section className="market-cards" aria-label="Company markets">
        <MarketCard title="OUT" qualifier="CEO OUT BY HORIZON" value={usd.format(row.eOut)} row={row} />
        <MarketCard title="STAY" qualifier="CEO STAYS THROUGH HORIZON" value={usd.format(row.eStay)} row={row} />
        <MarketCard title="EXIT" qualifier="DEPARTURE CONDITION" value={percent(row.pExit)} row={row} />
      </section>
      <section className="company-chart-section">
        <div className="section-heading"><p className="eyebrow">EXHIBIT A · TRAILING SEVEN DAYS</p><h2>Fire premium</h2></div>
        <PremiumChart history={history ?? []} row={row} />
      </section>
      <section className="company-chart-section">
        <div className="section-heading"><p className="eyebrow">EXHIBIT B · CONDITIONAL VALUE</p><h2>Expected company value</h2></div>
        <ConditionalValueChart history={history ?? []} row={row} />
      </section>
      <section className="company-chart-section">
        <div className="section-heading"><p className="eyebrow">EXHIBIT C · DEPARTURE PROBABILITY</p><h2>Departure probability</h2></div>
        <DepartureProbabilityChart history={history ?? []} row={row} />
      </section>
      <div className="company-workbench">
        <TradePanel row={row} />
        <PositionsCard row={row} />
      </div>
      <section className="filing-copy">
        <article>
          <p className="eyebrow">RESOLUTION CRITERIA</p>
          <h2>What counts as departure</h2>
          <p>The condition is true if, on or before {formatDate(row.chain.horizon)}, the CEO office ceases to be held by {row.ceo}, or the company publicly and irrevocably announces that {row.ceo} will cease to hold it. Termination, resignation, retirement, death, and an announced transition with a named successor or interim all count.</p>
          <p>The settlement read is {formatDate(row.chain.settleTime)}. OUT is valid only on departure; STAY is valid only on retention. The other conditional market is called off and paid-in cash is refunded.</p>
          {row.chain.resolved ? <p><strong>{row.chain.fired ? 'FIRE' : 'KEEP'} resolution:</strong> {usd.format(row.chain.settledPriceCents / 100)}. {row.chain.resolutionURI ? <a href={row.chain.resolutionURI} target="_blank" rel="noreferrer">Resolution source ↗</a> : 'Source recorded in the resolution transaction.'}</p> : null}
        </article>
        <article>
          <p className="eyebrow">LIQUIDITY FINDING</p>
          <h2>An explicit information subsidy</h2>
          <p>This market is subsidized with {subsidy === undefined ? '—' : subsidy.toLocaleString('en-US', { maximumFractionDigits: 0 })} pUSD via LMSR. The sponsor funds the automated market maker’s worst-case loss so one informed trader can always move a price.</p>
          {row.note ? <><h3>CEO context</h3><p>{row.note}</p>{row.sourceUrl ? <a href={row.sourceUrl} target="_blank" rel="noreferrer">Company context source ↗</a> : null}</> : <p>This is the resolved TEST filing. It remains off the public board and is available only by direct URL to demonstrate dispute and claim states.</p>}
        </article>
      </section>
    </main>
  )
}
