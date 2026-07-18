import type { BoardRow } from '../lib/board.ts'
import { usd } from '../lib/format.ts'

function position(value: number, row: BoardRow): number {
  const low = row.chain.floorCents / 100
  const high = row.chain.capCents / 100
  return Math.max(0, Math.min(100, ((value - low) / (high - low || 1)) * 100))
}

export function PriceBand({ row, compact = false }: { row: BoardRow; compact?: boolean }) {
  const resolved = row.chain.resolved ? row.chain.settledPriceCents / 100 : null
  return (
    <div className={`price-band${compact ? ' price-band--compact' : ''}`} aria-label={`Price band from ${usd.format(row.chain.floorCents / 100)} to ${usd.format(row.chain.capCents / 100)}`}>
      <div className="price-band__labels"><span>{usd.format(row.chain.floorCents / 100)}</span><span>Settlement band</span><span>{usd.format(row.chain.capCents / 100)}</span></div>
      <div className="price-band__track">
        <span className="price-pin price-pin--fire" style={{ left: `${position(row.eOut, row)}%` }}><i />if CEO leaves · {usd.format(row.eOut)}</span>
        <span className="price-pin price-pin--keep" style={{ left: `${position(row.eStay, row)}%` }}><i />if CEO stays · {usd.format(row.eStay)}</span>
        {resolved === null ? null : <span className="price-pin price-pin--resolved" style={{ left: `${position(resolved, row)}%` }}><i />resolved · {usd.format(resolved)}</span>}
      </div>
    </div>
  )
}
