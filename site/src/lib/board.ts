import { useMemo } from 'react'
import { useReadContract, useReadContracts } from 'wagmi'
import companiesJson from '../../../data/companies.json'
import { ADDR } from './config.ts'
import { coreAbi } from './v2Abi.ts'

const WAD = 1e18
const HISTORY_WINDOW_SECONDS = 7 * 24 * 60 * 60
const tickerById = new Map<number, string>()

export function registerTicker(id: number, ticker: string): void {
  tickerById.set(id, ticker)
}

export type CompanyMetadata = {
  name: string
  ceo: string
  ceoSince: string
  sector: string
  mcapB: number
  note?: string
  sourceUrl?: string
  condition_note?: string
}

export const COMPANY_METADATA = companiesJson as Record<string, CompanyMetadata>

export type ChainCompany = {
  ticker: string
  name: string
  ceo: string
  spotCents: number
  floorCents: number
  capCents: number
  horizon: number
  settleTime: number
  resolved: boolean
  fired: boolean
  settledPriceCents: number
  resolvedAt: number
  resolutionURI: string
}

export type BoardRow = {
  id: number
  ticker: string
  name: string
  ceo: string
  ceoSince: string
  sector: string
  mcapB: number
  spot: number
  midOut: number
  midStay: number
  pExit: number
  premium: number
  eOut: number
  eStay: number
  state: number
  note?: string
  sourceUrl?: string
  chain: ChainCompany
}

export type HistorySnapshot = {
  t: number
  rows: Record<string, [midOut: number, midStay: number, pExit: number, state: number]>
}

export type Prices = readonly [readonly bigint[], readonly bigint[], readonly bigint[], readonly number[]]

function toNumber(value: bigint | number): number {
  return typeof value === 'bigint' ? Number(value) : value
}

export function normalizeCompany(value: unknown): ChainCompany | null {
  if (!value || typeof value !== 'object') return null
  const company = value as Record<string, unknown>
  if (typeof company.ticker !== 'string') return null
  return {
    ticker: company.ticker,
    name: String(company.name ?? ''),
    ceo: String(company.ceo ?? ''),
    spotCents: toNumber(company.spotCents as bigint | number),
    floorCents: toNumber(company.floorCents as bigint | number),
    capCents: toNumber(company.capCents as bigint | number),
    horizon: toNumber(company.horizon as bigint | number),
    settleTime: toNumber(company.settleTime as bigint | number),
    resolved: Boolean(company.resolved),
    fired: Boolean(company.fired),
    settledPriceCents: toNumber(company.settledPriceCents as bigint | number),
    resolvedAt: toNumber(company.resolvedAt as bigint | number),
    resolutionURI: String(company.resolutionURI ?? ''),
  }
}

export function useBoard(): { rows: BoardRow[] | null; error?: Error; retry: () => void } {
  const prices = useReadContract({
    address: ADDR.core,
    abi: coreAbi,
    functionName: 'getAllPrices',
    query: { refetchInterval: 30_000 },
  })
  const priceData = prices.data as Prices | undefined
  const ids = useMemo(
    () => Array.from({ length: priceData?.[0].length ?? 0 }, (_, id) => id),
    [priceData],
  )
  const companies = useReadContracts({
    contracts: ids.map((id) => ({
      address: ADDR.core,
      abi: coreAbi,
      functionName: 'getCompany',
      args: [BigInt(id)],
    })),
    query: { enabled: ids.length > 0, refetchInterval: 30_000 },
  })

  const rows = useMemo(() => {
    if (!priceData || !companies.data) return null
    return ids.flatMap((id) => {
      const result = companies.data[id]
      if (!result || result.status !== 'success') return []
      const chain = normalizeCompany(result.result)
      if (!chain) return []
      registerTicker(id, chain.ticker)
      const metadata = COMPANY_METADATA[chain.ticker]
      if (!metadata) return []
      const midOut = Number(priceData[0][id]) / WAD
      const midStay = Number(priceData[1][id]) / WAD
      const pExit = Number(priceData[2][id]) / WAD
      const spot = chain.spotCents / 100
      const band = (chain.capCents - chain.floorCents) / 100
      const eOut = chain.floorCents / 100 + midOut * band
      const eStay = chain.floorCents / 100 + midStay * band
      return [{
        id,
        ticker: chain.ticker,
        name: metadata.name || chain.name,
        ceo: metadata.ceo || chain.ceo,
        ceoSince: metadata.ceoSince,
        sector: metadata.sector,
        mcapB: metadata.mcapB,
        spot,
        midOut,
        midStay,
        pExit,
        premium: spot === 0 ? 0 : (eOut - eStay) / spot,
        eOut,
        eStay,
        state: Number(priceData[3][id]),
        note: metadata.note,
        sourceUrl: metadata.sourceUrl,
        chain,
      } satisfies BoardRow]
    })
  }, [companies.data, ids, priceData])

  const error = prices.error ?? companies.error ?? undefined
  return {
    rows,
    error,
    retry: () => { void prices.refetch(); void companies.refetch() },
  }
}

export function fireSignal(rows: HistorySnapshot[], id: number): 'FIRE' | 'KEEP' | 'WATCH' {
  const ticker = tickerById.get(id)
  if (!ticker) return 'WATCH'
  const cutoff = Math.floor(Date.now() / 1000) - HISTORY_WINDOW_SECONDS
  const premiums = rows
    .filter((snapshot) => snapshot.t >= cutoff)
    .map((snapshot) => snapshot.rows[ticker])
    .filter((row): row is HistorySnapshot['rows'][string] => Boolean(row))
    .map(([midOut, midStay]) => midOut - midStay)
  if (premiums.length < 20) return 'WATCH'
  const positive = premiums.filter((premium) => premium > 0).length / premiums.length
  if (positive >= 0.9) return 'FIRE'
  const nonPositive = premiums.filter((premium) => premium <= 0).length / premiums.length
  return nonPositive >= 0.9 ? 'KEEP' : 'WATCH'
}
