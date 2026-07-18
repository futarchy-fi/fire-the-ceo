import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { fallback, http, type Address } from 'viem'
import { sepolia } from 'wagmi/chains'

type Deployment = {
  chainId: number
  pusd: string
  core?: string
  exchange?: string
  fireTheCeo?: string
  deployBlock: number
}

const deploymentModules = import.meta.glob('../../../data/deployment*.json', {
  eager: true,
  import: 'default',
}) as Record<string, Deployment>
const v2Deployment = deploymentModules['../../../data/deployment-v2.json']
const fallbackDeployment = deploymentModules['../../../data/deployment.json']
const deployment = v2Deployment ?? fallbackDeployment

if (!deployment) throw new Error('No FireTheCEO deployment file was found.')
const core = deployment.core ?? deployment.fireTheCeo
if (!core) throw new Error('Deployment is missing its core contract address.')

export const CHAIN = sepolia
export const RPCS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://sepolia.drpc.org',
] as const

export const ADDR = {
  chainId: deployment.chainId,
  pusd: deployment.pusd as Address,
  core: core as Address,
  fireTheCeo: core as Address,
  exchange: (deployment.exchange ?? core) as Address,
  deployBlock: deployment.deployBlock,
  isV2: Boolean(deployment.core && deployment.exchange),
} as const

export const RELAY_URL = (import.meta.env.VITE_RELAY_URL as string | undefined)?.replace(/\/$/, '')
  ?? 'https://ceo.futarchy.fi/relay'

export const wagmiConfig = getDefaultConfig({
  appName: 'Fire the CEO',
  projectId: '76fa3deb89f7aa56f09cf1ac472eccb4',
  chains: [CHAIN],
  transports: {
    [CHAIN.id]: fallback(RPCS.map((url) => http(url))),
  },
})
