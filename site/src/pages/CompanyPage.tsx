import { useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useReadContract, useReadContracts } from 'wagmi'
import { COMPANY_METADATA, fireSignal, normalizeCompany, registerTicker, type BoardRow, type Prices } from '../lib/board.ts'
import { ADDR } from '../lib/config.ts'
import { formatDate, percent, signedPercent, usd } from '../lib/format.ts'
import { useObservationHistory } from '../lib/observations.ts'
import { coreAbi } from '../lib/v2Abi.ts'
import { SignalBadge, type Verdict } from '../components/Verdict.tsx'
import { ConditionalValueChart, DepartureProbabilityChart } from '../components/MarketHistoryCharts.tsx'
import { PremiumChart } from '../components/PremiumChart.tsx'
import { PriceBand } from '../components/PriceBand.tsx'
import { EstimateSlider, type LmsrMarket } from '../components/EstimateSlider.tsx'
import { OrderBook } from '../components/OrderBook.tsx'
import { PositionsCard } from '../components/PositionsCard.tsx'
import { TradePanel } from '../components/TradePanel.tsx'

const WAD = 1e18

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

function marketLoss(market: LmsrMarket): number {
  const qL = Number(market.qL) / WAD
  const qS = Number(market.qS) / WAD
  const b = Number(market.b) / WAD
  const high = Math.max(qL, qS)
  return high + b * Math.log(Math.exp((qL - high) / b) + Math.exp((qS - high) / b)) - Math.min(qL, qS)
}

function shortDate(timestamp: number): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(timestamp * 1000)
}

function verdictSentence(verdict: Verdict, row: BoardRow, history: NonNullable<ReturnType<typeof useObservationHistory>['history']>): string {
  const observations = history.map((snapshot) => snapshot.rows[row.ticker]).filter(Boolean)
  if (observations.length < 20) return 'WATCH — fewer than 20 on-chain observations; there is not enough evidence for a board finding.'
  const positive = observations.filter(([leaves, stays]) => leaves > stays).length / observations.length
  if (verdict === 'FIRE') return `FIRE — the market priced the company higher without the CEO in ${percent(positive, 0)} of the trailing week’s on-chain observations.`
  if (verdict === 'KEEP') return `KEEP — the market priced the company no higher without the CEO in ${percent(1 - positive, 0)} of the trailing week’s on-chain observations.`
  return 'WATCH — neither scenario led in at least 90% of the trailing week’s on-chain observations.'
}

function ResolutionChip({ row, scenario }: { row: BoardRow; scenario: 'leaves' | 'stays' }) {
  if (!row.chain.resolved) return null
  const survives = scenario === 'leaves' ? row.chain.fired : !row.chain.fired
  return <span className={`resolution-chip ${survives ? 'resolution-chip--resolved' : 'resolution-chip--void'}`}>{survives ? `Resolved: ${usd.format(row.chain.settledPriceCents / 100)}` : 'Called off — refunded'}</span>
}

function ScenarioCard({ row, kind, market, scenario }: { row: BoardRow; kind: 0 | 1; market: LmsrMarket; scenario: 'leaves' | 'stays' }) {
  const leaves = scenario === 'leaves'
  const estimate = leaves ? row.eOut : row.eStay
  const horizon = shortDate(row.chain.horizon)
  return (
    <article className={`scenario-card scenario-card--${scenario}`}>
      <div className="scenario-card__head">
        <div><p className="eyebrow">{leaves ? 'CEO LEAVES' : 'CEO STAYS'}</p><h2>{leaves ? `If ${row.ceo} leaves ${row.ticker} by ${horizon}, where does the stock settle?` : `If ${row.ceo} stays, where does ${row.ticker} settle?`}</h2></div>
        <div className="scenario-estimate"><span>Market says</span><strong>{usd.format(estimate)}</strong></div>
      </div>
      <ResolutionChip row={row} scenario={scenario} />
      <p className="refund-rule">Only counts if the CEO actually {leaves ? 'leaves' : 'stays'} — otherwise every trade is called off and your cash is refunded exactly.</p>
      <PriceBand row={row} />
      {!row.chain.resolved ? <EstimateSlider row={row} kind={kind} market={market} currentMid={leaves ? row.midOut : row.midStay} /> : null}
      <OrderBook row={row} kind={kind} />
    </article>
  )
}

export function CompanyPage() {
  const { ticker = '' } = useParams()
  const wanted = decodeURIComponent(ticker).toUpperCase()
  const pricesRead = useReadContract({ address: ADDR.core, abi: coreAbi, functionName: 'getAllPrices', query: { refetchInterval: 30_000 } })
  const prices = pricesRead.data as Prices | undefined
  const ids = useMemo(() => Array.from({ length: prices?.[0].length ?? 0 }, (_, id) => id), [prices])
  const companies = useReadContracts({ contracts: ids.map((id) => ({ address: ADDR.core, abi: coreAbi, functionName: 'getCompany' as const, args: [BigInt(id)] })), query: { enabled: ids.length > 0, refetchInterval: 30_000 } })
  const row = useMemo(() => {
    if (!prices || !companies.data) return null
    for (const [id, result] of companies.data.entries()) {
      if (result.status !== 'success') continue
      const chain = normalizeCompany(result.result)
      if (chain?.ticker.toUpperCase() === wanted) return rowFromChain(id, chain, prices)
    }
    return undefined
  }, [companies.data, prices, wanted])
  const historyRows = useMemo(() => row ? [row] : null, [row])
  const { history, error: historyError } = useObservationHistory(historyRows)
  const marketsRead = useReadContract({ address: ADDR.core, abi: coreAbi, functionName: 'getMarkets', args: row ? [BigInt(row.id)] : undefined, query: { enabled: Boolean(row) } })
  const oracleRead = useReadContract({ address: ADDR.core, abi: coreAbi, functionName: 'oracle' })
  const markets = marketsRead.data as readonly LmsrMarket[] | undefined

  if (pricesRead.error || companies.error) return <main className="page-shell"><section className="notice" role="alert"><strong>RPC read failed.</strong><p>This company filing could not be read from Sepolia. Return to the board and retry.</p><Link to="/">Return to the board</Link></section></main>
  if (row === null) return <main className="page-shell"><p className="eyebrow">Reading company filing…</p></main>
  if (row === undefined) return <main className="page-shell prose-page"><p className="eyebrow">FILING NOT FOUND</p><h1>{wanted}</h1><p>No on-chain company uses this ticker.</p><Link to="/">Return to the board</Link></main>
  if (!markets) return <main className="page-shell"><p className="eyebrow">Reading market curves…</p></main>

  const verdict = history ? fireSignal(history, row.id) : 'WATCH'
  const verdictCopy = verdictSentence(verdict, row, history ?? [])
  const stateLabel = ['TRADING', 'AWAITING', 'DISPUTABLE', 'CLAIMABLE'][row.state] ?? 'UNKNOWN'
  const subsidy = markets.reduce((sum, market) => sum + marketLoss(market), 0)

  return (
    <main className="page-shell company-page">
      <Link className="back-link" to="/">← The board</Link>
      <header className="company-header">
        <div><p className="eyebrow">IN RE: {row.name.toUpperCase()} — {row.ceo.toUpperCase()}, CHIEF EXECUTIVE</p><h1>{row.ticker}</h1><p className="company-subhead">Memo to the board · CEO since {row.ceoSince} · {row.sector}</p></div>
        <div className="company-verdict"><SignalBadge verdict={verdict} large /><span>{verdict === 'WATCH' ? 'no signal — thin market' : 'trailing seven-day finding'}</span></div>
      </header>

      <section className="hero-finding">
        <div><span>Market says if they leave</span><strong className="is-fire">{usd.format(row.eOut)}</strong></div>
        <div><span>Market says if they stay</span><strong className="is-keep">{usd.format(row.eStay)}</strong></div>
        <div className="hero-premium"><span>Visible gap · fire premium</span><strong className={row.premium >= 0 ? 'is-fire' : 'is-keep'}>{usd.format(row.eOut - row.eStay)} · {signedPercent(row.premium)}</strong></div>
        <p><b>{verdict}</b> · {verdictCopy.replace(`${verdict} — `, '')}</p>
      </section>
      <PriceBand row={row} compact />
      <section className="company-facts"><div><span>Will {row.ceo} leave by {shortDate(row.chain.horizon)}?</span><strong>{percent(row.pExit)}</strong></div><div><span>Listing spot</span><strong>{usd.format(row.spot)}</strong></div><div><span>Liquidity subsidy</span><strong>{subsidy.toLocaleString('en-US', { maximumFractionDigits: 0 })} pUSD</strong></div><div><span>Docket state</span><strong>{stateLabel}</strong></div></section>

      <section className="scenario-grid" aria-label="Conditional company scenarios">
        <ScenarioCard row={row} kind={0} market={markets[0]} scenario="leaves" />
        <ScenarioCard row={row} kind={1} market={markets[1]} scenario="stays" />
      </section>

      <section className="departure-card">
        <div><p className="eyebrow">DEPARTURE CONDITION</p><h2>How likely is departure? <strong>{percent(row.pExit)}</strong></h2><p>Will {row.ceo} leave by {shortDate(row.chain.horizon)}? This probability market is separate from the two conditional stock-value estimates.</p></div>
        <DepartureProbabilityChart history={history ?? []} row={row} />
        <OrderBook row={row} kind={2} />
      </section>

      <section className="company-chart-section"><div className="section-heading"><p className="eyebrow">EXHIBIT A · FROM ON-CHAIN OBSERVATIONS</p><h2>Fire premium, trailing seven days</h2></div><PremiumChart history={history ?? []} row={row} /></section>
      <section className="company-chart-section"><div className="section-heading"><p className="eyebrow">EXHIBIT B · FROM ON-CHAIN OBSERVATIONS</p><h2>Conditional company value</h2></div><ConditionalValueChart history={history ?? []} row={row} /></section>
      {historyError ? <p className="data-note">The current market is live, but its on-chain observation buffer could not be read. Charts need at least two reconstructed intervals.</p> : null}

      <details className="advanced-ticket"><summary>Advanced · raw kind, side, and shares ticket</summary><TradePanel row={row} /></details>
      <PositionsCard row={row} />

      <section className="resolution-card" id="resolution">
        <p className="eyebrow">HOW THIS RESOLVES · UNIFORM DEPARTURE POLICY</p><h2>One rule, recorded before the outcome</h2>
        <div className="resolution-grid">
          <article><h3>What counts as departure</h3><p>Resignation, firing, retirement, death, or a public and irrevocable announcement that {row.ceo} will cease to hold the CEO office by {formatDate(row.chain.horizon)} counts. A named successor or interim counts; an honorary chair role does not undo departure. A temporary medical leave without relinquishing the office does not count.</p></article>
          <article><h3>When and from where</h3><p>The surviving conditional reads the official closing price on {formatDate(row.chain.settleTime)} at 21:00 UTC. Departure evidence follows the company’s 8-K or official press release; the closing tape is the settlement source.</p>{row.chain.resolutionURI ? <a href={row.chain.resolutionURI}>Recorded resolution source ↗</a> : null}</article>
          <article><h3>Band math</h3><p>The fixed band is [{usd.format(row.chain.floorCents / 100)}, {usd.format(row.chain.capCents / 100)}], equal to [0.25×, 1.75×] listing spot. At or above the top, higher exposure pays 1; inside, it pays (value − low) / (high − low); at or below the bottom, it pays 0.</p></article>
          <article><h3>Ambiguity and dispute</h3><p>Ambiguous departure means the CEO-stays scenario stands and the CEO-leaves scenario is called off and refunded. A resolution has a 48-hour dispute window. Oracle: <span className="mono-address">{oracleRead.data ?? 'reading from core…'}</span>.</p></article>
        </div>
        <Link to="/departure-policy">Read the shared CEO departure policy →</Link>
      </section>
    </main>
  )
}
