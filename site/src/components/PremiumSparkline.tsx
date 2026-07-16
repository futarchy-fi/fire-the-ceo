import type { BoardRow, HistorySnapshot } from '../lib/board.ts'

const WIDTH = 112
const HEIGHT = 32
const PAD = 3
const SEVEN_DAYS = 7 * 24 * 60 * 60

function premiumAt(snapshot: HistorySnapshot, row: BoardRow): number | null {
  const values = snapshot.rows[row.ticker]
  if (!values) return null
  const band = row.chain.capCents - row.chain.floorCents
  return row.chain.spotCents === 0 ? 0 : ((values[0] - values[1]) * band) / row.chain.spotCents
}

export function premiumHistory(history: HistorySnapshot[], row: BoardRow): { t: number; value: number }[] {
  const cutoff = Math.floor(Date.now() / 1000) - SEVEN_DAYS
  return history.flatMap((snapshot) => {
    const value = premiumAt(snapshot, row)
    return snapshot.t >= cutoff && value !== null ? [{ t: snapshot.t, value }] : []
  })
}

export function PremiumSparkline({ history, row }: { history: HistorySnapshot[]; row: BoardRow }) {
  const points = premiumHistory(history, row)
  if (points.length < 2) {
    return <span className="spark-empty"><span>WATCH</span> no signal — thin market</span>
  }
  const values = points.map((point) => point.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const path = points.map((point, index) => {
    const x = PAD + (index / (points.length - 1)) * (WIDTH - PAD * 2)
    const y = HEIGHT - PAD - ((point.value - min) / span) * (HEIGHT - PAD * 2)
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`
  }).join(' ')
  const last = points.at(-1)!
  const lastX = WIDTH - PAD
  const lastY = HEIGHT - PAD - ((last.value - min) / span) * (HEIGHT - PAD * 2)
  const endpointClass = last.value > 0 ? 'spark-end--fire' : 'spark-end--keep'
  const word = last.value > 0 ? 'FIRE' : 'KEEP'
  return (
    <svg className="sparkline" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`7-day premium trend; endpoint ${word}`}>
      <path d={path} fill="none" stroke="var(--dim)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      <circle className={endpointClass} cx={lastX} cy={lastY} r="2.5" />
    </svg>
  )
}
