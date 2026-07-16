import { useEffect, useState } from 'react'
import { formatUnits, type Abi, type Hash } from 'viem'
import { useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import fireAbiJson from '../lib/abi/FireTheCEO.json'
import { ADDR } from '../lib/config.ts'
import type { BoardRow } from '../lib/board.ts'

const FIRE_ABI = fireAbiJson as Abi
const MARKETS = ['OUT', 'STAY', 'EXIT']
type Position = { sharesL: bigint; sharesS: bigint; paidIn: bigint; escrow: bigint }
const amount = (value: bigint) => Number(formatUnits(value, 18)).toLocaleString('en-US', { maximumFractionDigits: 3 })

export function PositionsCard({ row }: { row: BoardRow }) {
  const { address } = useAccount()
  const [hash, setHash] = useState<Hash>()
  const [message, setMessage] = useState<string>()
  const { writeContractAsync, isPending } = useWriteContract()
  const receipt = useWaitForTransactionReceipt({ hash })
  const positions = useReadContract({
    address: ADDR.fireTheCeo, abi: FIRE_ABI, functionName: 'getPositions',
    args: address ? [address, BigInt(row.id)] : undefined,
    query: { enabled: Boolean(address), refetchInterval: 15_000 },
  })
  const data = positions.data as readonly Position[] | undefined
  const hasPosition = data?.some((position) => position.sharesL || position.sharesS || position.paidIn || position.escrow)
  useEffect(() => {
    if (receipt.isSuccess) { setMessage('Claim confirmed on Sepolia.'); setHash(undefined); void positions.refetch() }
    if (receipt.isError) { setMessage('Claim failed on Sepolia. Review the wallet error and retry.'); setHash(undefined) }
  }, [positions, receipt.isError, receipt.isSuccess])
  const claim = async () => {
    try {
      setMessage('Confirm the claim in your wallet.')
      const tx = await writeContractAsync({ address: ADDR.fireTheCeo, abi: FIRE_ABI, functionName: 'claim', args: [BigInt(row.id)] })
      setHash(tx); setMessage('Claim pending on Sepolia.')
    } catch (error) {
      setMessage(error instanceof Error ? `Claim stopped: ${error.message.split('\n')[0]}` : 'Claim stopped. Try again.')
    }
  }
  return (
    <section className="positions-card">
      <p className="eyebrow">WALLET POSITION</p>
      <h2>Cash and claims</h2>
      {!address ? <p>Connect a wallet to inspect its position in this filing.</p> : !data ? <p>Reading the position register…</p> : !hasPosition ? <p>No position in {row.ticker} yet — get pUSD from the faucet and file an order.</p> : (
        <div className="position-grid">{data.map((position, index) => (
          <article key={MARKETS[index]}>
            <h3>{MARKETS[index]}</h3>
            <dl>
              <div><dt>LONG</dt><dd>{amount(position.sharesL)}</dd></div>
              <div><dt>SHORT</dt><dd>{amount(position.sharesS)}</dd></div>
              <div><dt>Paid in</dt><dd>{amount(position.paidIn)} pUSD</dd></div>
              <div><dt>Escrow</dt><dd>{amount(position.escrow)} pUSD</dd></div>
            </dl>
          </article>
        ))}</div>
      )}
      {address && row.state === 3 ? <button type="button" className="primary-action" disabled={isPending || receipt.isLoading} onClick={() => void claim()}>Claim resolved positions</button> : null}
      {message ? <div className="toast" role="status">{message}</div> : null}
    </section>
  )
}
