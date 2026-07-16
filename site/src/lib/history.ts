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

export type MarketHistoryPoint = {
  t: number
  eOut: number
  eStay: number
  pExit: number
}

export function marketHistory(history: HistorySnapshot[], row: BoardRow): MarketHistoryPoint[] {
  const floor = row.chain.floorCents / 100
  const band = (row.chain.capCents - row.chain.floorCents) / 100
  return history.flatMap((snapshot) => {
    const values = snapshot.rows[row.ticker]
    if (!values) return []
    const eOut = floor + values[0] * band
    const eStay = floor + values[1] * band
    const pExit = Math.max(0, Math.min(1, values[2]))
    if (![snapshot.t, eOut, eStay, pExit].every(Number.isFinite)) return []
    return [{ t: snapshot.t, eOut, eStay, pExit }]
  }).sort((a, b) => a.t - b.t)
}
