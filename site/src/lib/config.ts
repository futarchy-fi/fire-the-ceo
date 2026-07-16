import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { fallback, http, type Address } from 'viem'
import { sepolia } from 'wagmi/chains'
import deploymentJson from '../../../data/deployment.json'

export const CHAIN = sepolia
export const RPCS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://sepolia.drpc.org',
] as const

export const ADDR = {
  chainId: deploymentJson.chainId,
  pusd: deploymentJson.pusd as Address,
  fireTheCeo: deploymentJson.fireTheCeo as Address,
  deployBlock: deploymentJson.deployBlock,
} as const

export const wagmiConfig = getDefaultConfig({
  appName: 'Fire the CEO',
  projectId: '76fa3deb89f7aa56f09cf1ac472eccb4',
  chains: [CHAIN],
  transports: {
    [CHAIN.id]: fallback(RPCS.map((url) => http(url))),
  },
})
