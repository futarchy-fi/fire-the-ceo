import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { PremiumSparkline } from '../components/PremiumSparkline.tsx'
import { SignalBadge, type Verdict } from '../components/Verdict.tsx'
import { fireSignal, useBoard, useHistory, type BoardRow } from '../lib/board.ts'
import { compactBillions, formatDate, percent, signedPercent, usd } from '../lib/format.ts'

type SortKey = 'rank' | 'company' | 'ceo' | 'pExit' | 'eOut' | 'eStay' | 'premium' | 'signal' | 'spark' | 'mcap'
type Direction = 'asc' | 'desc'

const sortLabels: { key: SortKey; label: string }[] = [
  { key: 'rank', label: 'Rank' },
  { key: 'company', label: 'Company + CEO' },
  { key: 'pExit', label: 'P(exit)' },
  { key: 'eOut', label: 'E[P|OUT]' },
  { key: 'eStay', label: 'E[P|STAY]' },
  { key: 'premium', label: 'Fire premium' },
  { key: 'signal', label: 'Signal' },
  { key: 'spark', label: '7d premium' },
  { key: 'mcap', label: 'Market cap' },
]

function verdictFor(row: BoardRow, history: ReturnType<typeof useHistory>): Verdict {
  return history ? fireSignal(history, row.id) : 'WATCH'
}

function compareRows(a: BoardRow, b: BoardRow, key: SortKey, history: ReturnType<typeof useHistory>): number {
  if (key === 'rank') return b.premium - a.premium
  if (key === 'company') return a.name.localeCompare(b.name)
  if (key === 'ceo') return a.ceo.localeCompare(b.ceo)
  if (key === 'pExit') return a.pExit - b.pExit
  if (key === 'eOut') return a.eOut - b.eOut
  if (key === 'eStay') return a.eStay - b.eStay
  if (key === 'premium' || key === 'spark') return a.premium - b.premium
  if (key === 'mcap') return a.mcapB - b.mcapB
  return verdictFor(a, history).localeCompare(verdictFor(b, history))
}

function SortButton({ entry, active, direction, onSort }: {
  entry: { key: SortKey; label: string }
  active: boolean
  direction: Direction
  onSort: (key: SortKey) => void
}) {
  return (
    <button className="sort-button" type="button" onClick={() => onSort(entry.key)} aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : undefined}>
      {entry.label}{active ? (direction === 'asc' ? ' ↑' : ' ↓') : ''}
    </button>
  )
}

function BoardRowView({ row, rank, history }: { row: BoardRow; rank: number; history: ReturnType<typeof useHistory> }) {
  const verdict = verdictFor(row, history)
  return (
    <tr>
      <td className="rank-cell">{String(rank).padStart(2, '0')}</td>
      <td className="company-cell">
        <Link to={`/company/${encodeURIComponent(row.ticker)}`}><strong>{row.ticker}</strong> · {row.name}</Link>
        <span>{row.ceo} · since {row.ceoSince}</span>
      </td>
      <td>{percent(row.pExit, 1)}</td>
      <td>{usd.format(row.eOut)}</td>
      <td>{usd.format(row.eStay)}</td>
      <td className={`premium-cell ${row.premium > 0 ? 'is-fire' : 'is-keep'}`}>{signedPercent(row.premium)}</td>
      <td><SignalBadge verdict={verdict} /></td>
      <td><PremiumSparkline history={history ?? []} row={row} /></td>
      <td>{compactBillions(row.mcapB)}</td>
    </tr>
  )
}

function BoardCard({ row, rank, history }: { row: BoardRow; rank: number; history: ReturnType<typeof useHistory> }) {
  const verdict = verdictFor(row, history)
  return (
    <article className="board-card">
      <div className="board-card__rank">{String(rank).padStart(2, '0')}</div>
      <div className="board-card__company">
        <Link to={`/company/${encodeURIComponent(row.ticker)}`}><strong>{row.ticker}</strong> · {row.name}</Link>
        <span>{row.ceo} · since {row.ceoSince}</span>
      </div>
      <div className={`board-card__premium ${row.premium > 0 ? 'is-fire' : 'is-keep'}`}>{signedPercent(row.premium)}</div>
      <SignalBadge verdict={verdict} />
      <dl>
        <div><dt>P(exit)</dt><dd>{percent(row.pExit)}</dd></div>
        <div><dt>E[P|OUT]</dt><dd>{usd.format(row.eOut)}</dd></div>
        <div><dt>E[P|STAY]</dt><dd>{usd.format(row.eStay)}</dd></div>
        <div><dt>Market cap</dt><dd>{compactBillions(row.mcapB)}</dd></div>
      </dl>
      <PremiumSparkline history={history ?? []} row={row} />
    </article>
  )
}

function Skeleton() {
  return <div className="skeleton-table" aria-label="Loading board">{Array.from({ length: 8 }, (_, index) => <div key={index} className="skeleton-row" />)}</div>
}

export function BoardPage() {
  const { rows, error, retry } = useBoard()
  const history = useHistory()
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('premium')
  const [direction, setDirection] = useState<Direction>('desc')
  const shown = useMemo(() => {
    if (!rows) return null
    const needle = query.trim().toLowerCase()
    const filtered = needle ? rows.filter((row) => [row.ticker, row.name, row.ceo, row.sector].some((value) => value.toLowerCase().includes(needle))) : rows
    return [...filtered].sort((a, b) => compareRows(a, b, sortKey, history) * (direction === 'asc' ? 1 : -1))
  }, [direction, history, query, rows, sortKey])
  const onSort = (key: SortKey) => {
    if (key === sortKey) setDirection((value) => value === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setDirection(key === 'company' || key === 'ceo' ? 'asc' : 'desc') }
  }
  const settle = rows?.[0]?.chain.settleTime

  return (
    <main className="page-shell board-page">
      <header className="filing-header board-heading">
        <p className="eyebrow">FORM FTC-100 · SEPOLIA TESTNET · CONTINUOUS FILING</p>
        <h1>Fire the CEO</h1>
        <p className="lede">Robin Hanson’s called-off decision market, made public across the boardroom. Ranked by the value investors assign to a CEO’s departure.</p>
      </header>
      <section className="totals-strip" aria-label="Filing totals">
        <div><span>Listing subsidy</span><strong>≈1.4M pUSD</strong></div>
        <div><span>Companies filed</span><strong>{rows?.length ?? '—'}</strong></div>
        <div><span>Resolution read</span><strong>{settle ? formatDate(settle) : '30 Oct 2026'}</strong></div>
      </section>
      <div className="board-tools">
        <label htmlFor="board-filter">Search the register</label>
        <input id="board-filter" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ticker, company, CEO, sector" />
        <p>{shown?.length ?? '—'} filings · live Sepolia read · 30s refresh</p>
      </div>
      {error ? (
        <section className="notice" role="alert">
          <strong>RPC read failed.</strong>
          <p>The Sepolia register did not answer. Check your connection, then retry the public RPC pair.</p>
          <button type="button" onClick={retry}>Retry RPC read</button>
        </section>
      ) : null}
      {!shown ? <Skeleton /> : shown.length === 0 ? (
        <p className="empty-state">No company matches this filing search.</p>
      ) : (
        <>
          <div className="board-table-wrap">
            <table className="board-table">
              <thead><tr>{sortLabels.filter((entry) => entry.key !== 'ceo').map((entry) => <th key={entry.key}><SortButton entry={entry} active={entry.key === sortKey} direction={direction} onSort={onSort} /></th>)}</tr></thead>
              <tbody>{shown.map((row, index) => <BoardRowView key={row.id} row={row} rank={index + 1} history={history} />)}</tbody>
            </table>
          </div>
          <div className="board-cards">{shown.map((row, index) => <BoardCard key={row.id} row={row} rank={index + 1} history={history} />)}</div>
        </>
      )}
      <footer className="board-footnote">
        <p><strong>Signal rule.</strong> FIRE when the premium is positive in at least 90% of observations during the trailing seven days; KEEP when non-positive in at least 90%. Fewer than 20 observations is WATCH — no signal, thin market.</p>
      </footer>
    </main>
  )
}
