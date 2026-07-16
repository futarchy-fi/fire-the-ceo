import { useId, useMemo, useRef, useState } from 'react'
import type { BoardRow, HistorySnapshot } from '../lib/board.ts'
import { premiumHistory } from './PremiumSparkline.tsx'
import { signedPercent } from '../lib/format.ts'

const WIDTH = 760
const HEIGHT = 280
const MARGIN = { top: 18, right: 18, bottom: 34, left: 58 }

export function PremiumChart({ history, row }: { history: HistorySnapshot[]; row: BoardRow }) {
  const points = premiumHistory(history, row)
  const [hover, setHover] = useState<number | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const id = useId().replaceAll(':', '')
  const geometry = useMemo(() => {
    if (points.length < 2) return null
    const minT = points[0].t
    const maxT = points.at(-1)!.t
    const values = points.map((point) => point.value)
    const maxAbs = Math.max(...values.map(Math.abs), 0.01) * 1.12
    const x = (t: number) => MARGIN.left + ((t - minT) / (maxT - minT || 1)) * (WIDTH - MARGIN.left - MARGIN.right)
    const y = (value: number) => MARGIN.top + ((maxAbs - value) / (maxAbs * 2)) * (HEIGHT - MARGIN.top - MARGIN.bottom)
    const line = points.map((point, index) => `${index ? 'L' : 'M'}${x(point.t).toFixed(2)} ${y(point.value).toFixed(2)}`).join(' ')
    const zeroY = y(0)
    const area = `${line} L${x(maxT).toFixed(2)} ${zeroY.toFixed(2)} L${x(minT).toFixed(2)} ${zeroY.toFixed(2)} Z`
    return { minT, maxT, maxAbs, x, y, line, zeroY, area }
  }, [points])

  if (!geometry) {
    return (
      <div className="chart-empty">
        <strong>WATCH</strong>
        <span>No signal — thin market. Premium history will appear after two snapshots.</span>
      </div>
    )
  }
  const current = hover === null ? null : points[hover]
  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const plotX = ((event.clientX - bounds.left) / bounds.width) * WIDTH
    const ratio = Math.max(0, Math.min(1, (plotX - MARGIN.left) / (WIDTH - MARGIN.left - MARGIN.right)))
    setHover(Math.round(ratio * (points.length - 1)))
  }
  const tooltipLeft = current ? `${(geometry.x(current.t) / WIDTH) * 100}%` : '0%'
  const tooltipTop = current ? `${(geometry.y(current.value) / HEIGHT) * 100}%` : '0%'

  return (
    <div className="premium-chart" ref={wrap}>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} onPointerMove={onPointerMove} onPointerLeave={() => setHover(null)} role="img" aria-label="Fire premium over the trailing seven days">
        <defs>
          <clipPath id={`${id}-above`}><rect x="0" y="0" width={WIDTH} height={geometry.zeroY} /></clipPath>
          <clipPath id={`${id}-below`}><rect x="0" y={geometry.zeroY} width={WIDTH} height={HEIGHT - geometry.zeroY} /></clipPath>
        </defs>
        <path d={geometry.area} fill="var(--fire)" opacity="0.08" clipPath={`url(#${id}-above)`} />
        <path d={geometry.area} fill="var(--keep)" opacity="0.08" clipPath={`url(#${id}-below)`} />
        <line x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={geometry.zeroY} y2={geometry.zeroY} stroke="var(--rule)" strokeWidth="1" strokeDasharray="5 5" />
        <path d={geometry.line} fill="none" stroke="var(--ink)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <text x={MARGIN.left - 8} y={MARGIN.top + 4} textAnchor="end">{signedPercent(geometry.maxAbs, 1)}</text>
        <text x={MARGIN.left - 8} y={geometry.zeroY + 4} textAnchor="end">+0.0%</text>
        <text x={MARGIN.left - 8} y={HEIGHT - MARGIN.bottom + 4} textAnchor="end">{signedPercent(-geometry.maxAbs, 1)}</text>
        <text x={MARGIN.left} y={HEIGHT - 10}>{new Date(geometry.minT * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</text>
        <text x={WIDTH - MARGIN.right} y={HEIGHT - 10} textAnchor="end">{new Date(geometry.maxT * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</text>
        {current ? <>
          <line x1={geometry.x(current.t)} x2={geometry.x(current.t)} y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom} stroke="var(--dim)" strokeWidth="1" strokeDasharray="2 3" />
          <circle cx={geometry.x(current.t)} cy={geometry.y(current.value)} r="4" fill="var(--paper)" stroke="var(--ink)" strokeWidth="2" />
        </> : null}
      </svg>
      {current ? (
        <div className="chart-tooltip" style={{ left: tooltipLeft, top: tooltipTop }}>
          <strong>{signedPercent(current.value)}</strong>
          <span>{new Date(current.t * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC</span>
        </div>
      ) : null}
    </div>
  )
}
