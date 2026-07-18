import { useMemo } from 'react'
import { useReadContracts } from 'wagmi'
import { ADDR } from './config.ts'
import { coreAbi } from './v2Abi.ts'
import type { BoardRow, HistorySnapshot } from './board.ts'

const WAD = 1e18
const STEP = 6 * 60 * 60
const WINDOW = 7 * 24 * 60 * 60
const BUFFER_SIZE = 256

type ReadResult<T> = { status: 'success'; result: T } | { status: 'failure'; error: Error }
type ObservationState = readonly [index: number, cardinality: number]
type Observation = { blockTimestamp: number | bigint; cumulativePriceWad: bigint }

function secondsAgosSince(oldestTimestamp: number): number[] {
  const available = Math.max(0, Math.floor(Date.now() / 1000) - oldestTimestamp - 30)
  const span = Math.min(WINDOW, Math.floor(available / STEP) * STEP)
  if (span < STEP) return [Math.max(0, available), 0]
  return Array.from({ length: span / STEP + 1 }, (_, index) => span - index * STEP)
}

function averageIntervals(cumulative: readonly bigint[], secondsAgos: readonly number[]): number[] {
  if (cumulative.length !== secondsAgos.length) return []
  return cumulative.slice(1).map((value, index) => {
    const elapsed = secondsAgos[index] - secondsAgos[index + 1]
    return elapsed > 0 ? Number(value - cumulative[index]) / elapsed / WAD : 0
  })
}

export function reconstructHistory(rows: BoardRow[], results: readonly ReadResult<readonly bigint[]>[], secondsAgos: readonly number[], now = Math.floor(Date.now() / 1000)): HistorySnapshot[] {
  const snapshots = new Map<number, HistorySnapshot>()
  rows.forEach((row, rowIndex) => {
    const series = [0, 1, 2].map((kind) => {
      const read = results[rowIndex * 3 + kind]
      return read?.status === 'success' ? averageIntervals(read.result, secondsAgos) : []
    })
    const points = Math.min(...series.map((values) => values.length))
    for (let index = 0; index < points; index += 1) {
      const t = now - secondsAgos[index + 1]
      const snapshot = snapshots.get(t) ?? { t, rows: {} }
      snapshot.rows[row.ticker] = [series[0][index], series[1][index], series[2][index], row.state]
      snapshots.set(t, snapshot)
    }
  })
  return [...snapshots.values()].sort((a, b) => a.t - b.t)
}

export function useObservationHistory(rows: BoardRow[] | null | undefined): { history: HistorySnapshot[] | null; error?: Error } {
  const marketIds = useMemo(() => (rows ?? []).flatMap((row) => [0, 1, 2].map((kind) => row.id * 3 + kind)), [rows])
  const states = useReadContracts({
    contracts: marketIds.map((marketId) => ({ address: ADDR.core, abi: coreAbi, functionName: 'observationStates' as const, args: [BigInt(marketId)] })),
    allowFailure: true, query: { enabled: marketIds.length > 0, refetchInterval: 60_000 },
  })
  const oldestContracts = useMemo(() => marketIds.flatMap((marketId, index) => {
    const read = states.data?.[index] as ReadResult<ObservationState> | undefined
    if (read?.status !== 'success' || read.result[1] === 0) return []
    const [currentIndex, cardinality] = read.result
    const oldestIndex = cardinality < BUFFER_SIZE ? 0 : (currentIndex + 1) % BUFFER_SIZE
    return [{ address: ADDR.core, abi: coreAbi, functionName: 'getObservation' as const, args: [BigInt(marketId), oldestIndex] }]
  }), [marketIds, states.data])
  const oldest = useReadContracts({ contracts: oldestContracts, allowFailure: true, query: { enabled: oldestContracts.length === marketIds.length && marketIds.length > 0, refetchInterval: 60_000 } })
  const secondsAgos = useMemo(() => {
    if (!oldest.data || oldest.data.length !== marketIds.length) return []
    const timestamps = oldest.data.flatMap((read) => {
      const result = read as ReadResult<Observation>
      return result.status === 'success' ? [Number(result.result.blockTimestamp)] : []
    })
    return timestamps.length === marketIds.length ? secondsAgosSince(Math.max(...timestamps)) : []
  }, [marketIds.length, oldest.data])
  const contracts = useMemo(() => marketIds.map((marketId) => ({ address: ADDR.core, abi: coreAbi, functionName: 'observe' as const, args: [BigInt(marketId), secondsAgos] })), [marketIds, secondsAgos])
  const reads = useReadContracts({ contracts, allowFailure: true, query: { enabled: contracts.length > 0 && secondsAgos.length >= 2, refetchInterval: 60_000 } })
  const history = useMemo(() => {
    if (!rows || !reads.data || !secondsAgos.length) return null
    return reconstructHistory(rows, reads.data as readonly ReadResult<readonly bigint[]>[], secondsAgos)
  }, [reads.data, rows, secondsAgos])
  return { history, error: states.error ?? oldest.error ?? reads.error ?? undefined }
}
