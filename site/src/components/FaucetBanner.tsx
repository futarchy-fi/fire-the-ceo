import { useEffect, useState } from 'react'
import { maxUint256, type Abi, type Hash } from 'viem'
import { useAccount, useChainId, useReadContract, useSwitchChain, useWaitForTransactionReceipt, useWalletClient, useWriteContract } from 'wagmi'
import pusdAbiJson from '../lib/abi/PlayUSD.json'
import { ADDR, CHAIN, RPCS } from '../lib/config.ts'

const PUSD_ABI = pusdAbiJson as Abi

export function FaucetBanner() {
  const { address } = useAccount()
  const chainId = useChainId()
  const { data: walletClient } = useWalletClient()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync, isPending } = useWriteContract()
  const [hash, setHash] = useState<Hash>()
  const [action, setAction] = useState<'faucet' | 'approve'>()
  const [status, setStatus] = useState<string>()
  const receipt = useWaitForTransactionReceipt({ hash })
  const balanceRead = useReadContract({
    address: ADDR.pusd, abi: PUSD_ABI, functionName: 'balanceOf', args: address ? [address] : undefined,
    query: { enabled: Boolean(address), refetchInterval: 15_000 },
  })
  const allowanceRead = useReadContract({
    address: ADDR.pusd, abi: PUSD_ABI, functionName: 'allowance', args: address ? [address, ADDR.fireTheCeo] : undefined,
    query: { enabled: Boolean(address), refetchInterval: 15_000 },
  })
  const balance = balanceRead.data as bigint | undefined
  const allowance = allowanceRead.data as bigint | undefined
  const needsFunds = balance === 0n
  const needsApproval = balance !== undefined && balance > 0n && allowance === 0n

  useEffect(() => {
    if (receipt.isSuccess) {
      setStatus(action === 'faucet' ? 'Faucet confirmed. Approve the market contract for your first order.' : 'Approval confirmed. The order ticket is ready.')
      setHash(undefined)
      void balanceRead.refetch()
      void allowanceRead.refetch()
    }
    if (receipt.isError) {
      setStatus(`${action === 'faucet' ? 'Faucet' : 'Approval'} failed on Sepolia. Review the wallet error and try again.`)
      setHash(undefined)
    }
  }, [action, allowanceRead, balanceRead, receipt.isError, receipt.isSuccess])

  if (!address || balance === undefined || allowance === undefined || (!needsFunds && !needsApproval)) return null

  const addSepolia = async () => {
    if (!walletClient) return
    try {
      setStatus('Adding the Sepolia test network to your wallet.')
      await walletClient.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: '0xaa36a7',
          chainName: 'Sepolia',
          nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: [...RPCS],
          blockExplorerUrls: ['https://sepolia.etherscan.io'],
        }],
      })
      if (chainId !== CHAIN.id) await switchChainAsync({ chainId: CHAIN.id })
      setStatus('Sepolia is ready.')
    } catch (error) {
      setStatus(error instanceof Error ? `Network setup stopped: ${error.message.split('\n')[0]}` : 'Network setup stopped. Try again.')
    }
  }

  const write = async (nextAction: 'faucet' | 'approve') => {
    try {
      if (chainId !== CHAIN.id) await switchChainAsync({ chainId: CHAIN.id })
      setAction(nextAction)
      setStatus(`Confirm ${nextAction === 'faucet' ? 'the 10,000 pUSD faucet mint' : 'market approval'} in your wallet.`)
      const tx = nextAction === 'faucet'
        ? await writeContractAsync({ address: ADDR.pusd, abi: PUSD_ABI, functionName: 'faucet' })
        : await writeContractAsync({ address: ADDR.pusd, abi: PUSD_ABI, functionName: 'approve', args: [ADDR.fireTheCeo, maxUint256] })
      setHash(tx)
      setStatus(`${nextAction === 'faucet' ? 'Faucet' : 'Approval'} pending on Sepolia.`)
    } catch (error) {
      const fallback = nextAction === 'faucet' ? 'The faucet may still be in its 24-hour cooldown.' : 'Approval was not submitted.'
      setStatus(error instanceof Error ? `${fallback} ${error.message.split('\n')[0]}` : fallback)
    }
  }

  return (
    <aside className="faucet-banner" aria-label="First trade setup">
      <div>
        <p className="eyebrow">FIRST-RUN FILING · SEPOLIA ONLY</p>
        <strong>{needsFunds ? 'Your wallet has 0 pUSD.' : 'Authorize your first order.'}</strong>
        <span>{needsFunds ? 'Add the test network, mint play collateral, then approve the market contract.' : 'Your faucet collateral arrived. One approval enables the order ticket.'}</span>
      </div>
      <ol>
        <li><button type="button" onClick={() => void addSepolia()} disabled={isPending}>1 · Add Sepolia{chainId === CHAIN.id ? ' ✓' : ''}</button></li>
        <li><button type="button" onClick={() => void write('faucet')} disabled={!needsFunds || isPending || receipt.isLoading}>2 · Mint 10,000 pUSD{!needsFunds ? ' ✓' : ''}</button></li>
        <li><button type="button" onClick={() => void write('approve')} disabled={needsFunds || !needsApproval || isPending || receipt.isLoading}>3 · Approve market{!needsApproval && !needsFunds ? ' ✓' : ''}</button></li>
      </ol>
      {status ? <p className="faucet-status" role="status">{status}</p> : null}
    </aside>
  )
}
