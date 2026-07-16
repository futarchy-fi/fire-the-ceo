import type { BoardRow, HistorySnapshot } from './board.ts'

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
