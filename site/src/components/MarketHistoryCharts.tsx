import { useMemo, useState } from 'react'
import type { PointerEvent } from 'react'
import type { BoardRow, HistorySnapshot } from '../lib/board.ts'
import { marketHistory, type MarketHistoryPoint } from '../lib/history.ts'
import { percent, signedPercent, usd } from '../lib/format.ts'

const WIDTH = 760
const HEIGHT = 280
const VALUE_MARGIN = { top: 18, right: 76, bottom: 34, left: 68 }
const PROBABILITY_MARGIN = { top: 18, right: 18, bottom: 34, left: 58 }

type Scale = {
  minT: number
  maxT: number
  x: (t: number) => number
  y: (value: number) => number
}

function ChartEmpty() {
  return (
    <div className="chart-empty">
      <strong>WATCH</strong>
      <span>Price history will appear after two snapshots.</span>
    </div>
  )
}

function timestamp(value: number): string {
  return new Date(value * 1000).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  })
}

function shortDate(value: number): string {
  return new Date(value * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

function pathFor(points: MarketHistoryPoint[], scale: Scale, value: (point: MarketHistoryPoint) => number): string {
  return points.map((point, index) => `${index ? 'L' : 'M'}${scale.x(point.t).toFixed(2)} ${scale.y(value(point)).toFixed(2)}`).join(' ')
}

function nearestPoint(event: PointerEvent<SVGSVGElement>, points: MarketHistoryPoint[], x: (t: number) => number): number {
  const bounds = event.currentTarget.getBoundingClientRect()
  const pointerX = ((event.clientX - bounds.left) / bounds.width) * WIDTH
  let nearest = 0
  for (let index = 1; index < points.length; index += 1) {
    if (Math.abs(x(points[index].t) - pointerX) < Math.abs(x(points[nearest].t) - pointerX)) nearest = index
  }
  return nearest
}

function tooltipClass(x: number): string {
  return x > WIDTH * 0.72 ? 'chart-tooltip chart-tooltip--left' : 'chart-tooltip'
}

function ConditionalLegend() {
  return (
    <div className="chart-legend" aria-label="Chart legend">
      <span><i className="chart-key chart-key--fire" />E[value|OUT]</span>
      <span><i className="chart-key chart-key--keep" />E[value|STAY]</span>
      <span><i className="chart-key chart-key--spot" />Spot at listing</span>
    </div>
  )
}

export function ConditionalValueChart({ history, row }: { history: HistorySnapshot[]; row: BoardRow }) {
  const points = useMemo(() => marketHistory(history, row), [history, row])
  const [hover, setHover] = useState<number | null>(null)
  const geometry = useMemo(() => {
    if (points.length < 2) return null
    const minT = points[0].t
    const maxT = points.at(-1)!.t
    const values = points.flatMap((point) => [point.eOut, point.eStay]).concat(row.spot)
    const rawMin = Math.min(...values)
    const rawMax = Math.max(...values)
    const span = Math.max(rawMax - rawMin, Math.max(Math.abs(rawMin), Math.abs(rawMax)) * 0.04, 1)
    const minValue = rawMin - span * 0.1
    const maxValue = rawMax + span * 0.1
    const x = (t: number) => VALUE_MARGIN.left + ((t - minT) / (maxT - minT || 1)) * (WIDTH - VALUE_MARGIN.left - VALUE_MARGIN.right)
    const y = (value: number) => VALUE_MARGIN.top + ((maxValue - value) / (maxValue - minValue)) * (HEIGHT - VALUE_MARGIN.top - VALUE_MARGIN.bottom)
    const scale = { minT, maxT, x, y }
    const outLine = pathFor(points, scale, (point) => point.eOut)
    const stayLine = pathFor(points, scale, (point) => point.eStay)
    const last = points.at(-1)!
    let outLabelY = y(last.eOut)
    let stayLabelY = y(last.eStay)
    if (Math.abs(outLabelY - stayLabelY) < 16) {
      if (outLabelY <= stayLabelY) {
        outLabelY -= 8
        stayLabelY += 8
      } else {
        outLabelY += 8
        stayLabelY -= 8
      }
    }
    outLabelY = Math.max(VALUE_MARGIN.top + 5, Math.min(HEIGHT - VALUE_MARGIN.bottom - 5, outLabelY))
    stayLabelY = Math.max(VALUE_MARGIN.top + 5, Math.min(HEIGHT - VALUE_MARGIN.bottom - 5, stayLabelY))
    return { ...scale, minValue, maxValue, outLine, stayLine, outLabelY, stayLabelY }
  }, [points, row.spot])

  if (!geometry) return <ChartEmpty />
  const current = hover === null ? null : points[hover]
  const plotRight = WIDTH - VALUE_MARGIN.right
  const onPointer = (event: PointerEvent<SVGSVGElement>) => setHover(nearestPoint(event, points, geometry.x))

  return (
    <div className="premium-chart history-chart">
      <ConditionalLegend />
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} onPointerDown={onPointer} onPointerMove={onPointer} onPointerLeave={() => setHover(null)} role="img" aria-label="Conditional company value history for CEO departure and retention">
        <line x1={VALUE_MARGIN.left} x2={plotRight} y1={geometry.y(row.spot)} y2={geometry.y(row.spot)} stroke="var(--rule)" strokeWidth="1" strokeDasharray="5 5" />
        <text x={VALUE_MARGIN.left + 6} y={geometry.y(row.spot) - 7}>spot at listing</text>
        <path d={geometry.outLine} fill="none" stroke="var(--fire)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <path d={geometry.stayLine} fill="none" stroke="var(--keep)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <line x1={plotRight + 7} x2={plotRight + 17} y1={geometry.outLabelY} y2={geometry.outLabelY} stroke="var(--fire)" strokeWidth="2" />
        <text className="chart-direct-label" x={plotRight + 21} y={geometry.outLabelY + 4}>OUT</text>
        <line x1={plotRight + 7} x2={plotRight + 17} y1={geometry.stayLabelY} y2={geometry.stayLabelY} stroke="var(--keep)" strokeWidth="2" />
        <text className="chart-direct-label" x={plotRight + 21} y={geometry.stayLabelY + 4}>STAY</text>
        <text x={VALUE_MARGIN.left - 8} y={VALUE_MARGIN.top + 4} textAnchor="end">{usd.format(geometry.maxValue)}</text>
        <text x={VALUE_MARGIN.left - 8} y={(VALUE_MARGIN.top + HEIGHT - VALUE_MARGIN.bottom) / 2 + 4} textAnchor="end">{usd.format((geometry.minValue + geometry.maxValue) / 2)}</text>
        <text x={VALUE_MARGIN.left - 8} y={HEIGHT - VALUE_MARGIN.bottom + 4} textAnchor="end">{usd.format(geometry.minValue)}</text>
        <text x={VALUE_MARGIN.left} y={HEIGHT - 10}>{shortDate(geometry.minT)}</text>
        <text x={plotRight} y={HEIGHT - 10} textAnchor="end">{shortDate(geometry.maxT)}</text>
        {current ? <>
          <line x1={geometry.x(current.t)} x2={geometry.x(current.t)} y1={VALUE_MARGIN.top} y2={HEIGHT - VALUE_MARGIN.bottom} stroke="var(--dim)" strokeWidth="1" strokeDasharray="2 3" />
          <circle cx={geometry.x(current.t)} cy={geometry.y(current.eOut)} r="4" fill="var(--paper)" stroke="var(--fire)" strokeWidth="2" />
          <circle cx={geometry.x(current.t)} cy={geometry.y(current.eStay)} r="4" fill="var(--paper)" stroke="var(--keep)" strokeWidth="2" />
        </> : null}
      </svg>
      {current ? (
        <div className={tooltipClass(geometry.x(current.t))} style={{ left: `${(geometry.x(current.t) / WIDTH) * 100}%`, top: `${(Math.min(geometry.y(current.eOut), geometry.y(current.eStay)) / HEIGHT) * 100}%` }}>
          <strong>{timestamp(current.t)} UTC</strong>
          <span>OUT {usd.format(current.eOut)}</span>
          <span>STAY {usd.format(current.eStay)}</span>
          <span>Premium {signedPercent(row.spot ? (current.eOut - current.eStay) / row.spot : 0)}</span>
        </div>
      ) : null}
    </div>
  )
}

function probabilityDomain(points: MarketHistoryPoint[]): [number, number] {
  const values = points.map((point) => point.pExit)
  const observedMin = Math.min(...values)
  const observedMax = Math.max(...values)
  const observedSpan = Math.max(observedMax - observedMin, 0.08)
  let min = Math.max(0, observedMin - Math.max(0.025, observedSpan * 0.2))
  let max = Math.min(1, observedMax + Math.max(0.025, observedSpan * 0.2))
  if (max - min < 0.1) {
    const center = (min + max) / 2
    min = Math.max(0, center - 0.05)
    max = Math.min(1, center + 0.05)
    if (min === 0) max = 0.1
    if (max === 1) min = 0.9
  }
  return [min, max]
}

export function DepartureProbabilityChart({ history, row }: { history: HistorySnapshot[]; row: BoardRow }) {
  const points = useMemo(() => marketHistory(history, row), [history, row])
  const [hover, setHover] = useState<number | null>(null)
  const geometry = useMemo(() => {
    if (points.length < 2) return null
    const minT = points[0].t
    const maxT = points.at(-1)!.t
    const [minValue, maxValue] = probabilityDomain(points)
    const x = (t: number) => PROBABILITY_MARGIN.left + ((t - minT) / (maxT - minT || 1)) * (WIDTH - PROBABILITY_MARGIN.left - PROBABILITY_MARGIN.right)
    const y = (value: number) => PROBABILITY_MARGIN.top + ((maxValue - value) / (maxValue - minValue)) * (HEIGHT - PROBABILITY_MARGIN.top - PROBABILITY_MARGIN.bottom)
    const scale = { minT, maxT, x, y }
    return { ...scale, minValue, maxValue, line: pathFor(points, scale, (point) => point.pExit) }
  }, [points])

  if (!geometry) return <ChartEmpty />
  const current = hover === null ? null : points[hover]
  const plotRight = WIDTH - PROBABILITY_MARGIN.right
  const onPointer = (event: PointerEvent<SVGSVGElement>) => setHover(nearestPoint(event, points, geometry.x))

  return (
    <div className="premium-chart history-chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} onPointerDown={onPointer} onPointerMove={onPointer} onPointerLeave={() => setHover(null)} role="img" aria-label="CEO departure probability history">
        <path d={geometry.line} fill="none" stroke="var(--ink)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <text x={PROBABILITY_MARGIN.left - 8} y={PROBABILITY_MARGIN.top + 4} textAnchor="end">{percent(geometry.maxValue)}</text>
        <text x={PROBABILITY_MARGIN.left - 8} y={(PROBABILITY_MARGIN.top + HEIGHT - PROBABILITY_MARGIN.bottom) / 2 + 4} textAnchor="end">{percent((geometry.minValue + geometry.maxValue) / 2)}</text>
        <text x={PROBABILITY_MARGIN.left - 8} y={HEIGHT - PROBABILITY_MARGIN.bottom + 4} textAnchor="end">{percent(geometry.minValue)}</text>
        <text x={PROBABILITY_MARGIN.left} y={HEIGHT - 10}>{shortDate(geometry.minT)}</text>
        <text x={plotRight} y={HEIGHT - 10} textAnchor="end">{shortDate(geometry.maxT)}</text>
        {current ? <>
          <line x1={geometry.x(current.t)} x2={geometry.x(current.t)} y1={PROBABILITY_MARGIN.top} y2={HEIGHT - PROBABILITY_MARGIN.bottom} stroke="var(--dim)" strokeWidth="1" strokeDasharray="2 3" />
          <circle cx={geometry.x(current.t)} cy={geometry.y(current.pExit)} r="4" fill="var(--paper)" stroke="var(--ink)" strokeWidth="2" />
        </> : null}
      </svg>
      {current ? (
        <div className={tooltipClass(geometry.x(current.t))} style={{ left: `${(geometry.x(current.t) / WIDTH) * 100}%`, top: `${(geometry.y(current.pExit) / HEIGHT) * 100}%` }}>
          <strong>{timestamp(current.t)} UTC</strong>
          <span>Departure {percent(current.pExit)}</span>
        </div>
      ) : null}
    </div>
  )
}
