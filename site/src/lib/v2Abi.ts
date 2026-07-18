export const coreAbi = [
  { type: 'function', name: 'getAllPrices', stateMutability: 'view', inputs: [], outputs: [
    { name: 'midOut', type: 'uint256[]' }, { name: 'midStay', type: 'uint256[]' },
    { name: 'pExit', type: 'uint256[]' }, { name: 'state', type: 'uint8[]' },
  ] },
  { type: 'function', name: 'getCompany', stateMutability: 'view', inputs: [{ name: 'companyId', type: 'uint256' }], outputs: [{ name: '', type: 'tuple', components: [
    { name: 'ticker', type: 'string' }, { name: 'name', type: 'string' }, { name: 'ceo', type: 'string' },
    { name: 'spotCents', type: 'uint32' }, { name: 'floorCents', type: 'uint32' }, { name: 'capCents', type: 'uint32' },
    { name: 'horizon', type: 'uint64' }, { name: 'settleTime', type: 'uint64' }, { name: 'resolved', type: 'bool' },
    { name: 'fired', type: 'bool' }, { name: 'settledPriceCents', type: 'uint32' }, { name: 'resolvedAt', type: 'uint64' },
    { name: 'resolutionURI', type: 'string' },
  ] }] },
  { type: 'function', name: 'getMarkets', stateMutability: 'view', inputs: [{ name: 'companyId', type: 'uint256' }], outputs: [{ name: '', type: 'tuple[3]', components: [
    { name: 'qL', type: 'int128' }, { name: 'qS', type: 'int128' }, { name: 'b', type: 'uint128' },
  ] }] },
  { type: 'function', name: 'observe', stateMutability: 'view', inputs: [{ name: 'marketId', type: 'uint256' }, { name: 'secondsAgos', type: 'uint32[]' }], outputs: [{ name: 'cumulativePrices', type: 'uint256[]' }] },
  { type: 'function', name: 'observationStates', stateMutability: 'view', inputs: [{ name: '', type: 'uint256' }], outputs: [{ name: 'index', type: 'uint16' }, { name: 'cardinality', type: 'uint16' }] },
  { type: 'function', name: 'getObservation', stateMutability: 'view', inputs: [{ name: 'marketId', type: 'uint256' }, { name: 'index', type: 'uint16' }], outputs: [{ name: '', type: 'tuple', components: [{ name: 'blockTimestamp', type: 'uint32' }, { name: 'cumulativePriceWad', type: 'uint224' }] }] },
  { type: 'function', name: 'oracle', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'quoteBuy', stateMutability: 'view', inputs: [{ name: 'companyId', type: 'uint256' }, { name: 'kind', type: 'uint8' }, { name: 'longSide', type: 'bool' }, { name: 'shares', type: 'uint256' }], outputs: [{ name: 'cost', type: 'uint256' }] },
  { type: 'function', name: 'quoteSell', stateMutability: 'view', inputs: [{ name: 'companyId', type: 'uint256' }, { name: 'kind', type: 'uint8' }, { name: 'longSide', type: 'bool' }, { name: 'shares', type: 'uint256' }], outputs: [{ name: 'proceeds', type: 'uint256' }] },
  { type: 'function', name: 'buy', stateMutability: 'nonpayable', inputs: [{ name: 'companyId', type: 'uint256' }, { name: 'kind', type: 'uint8' }, { name: 'longSide', type: 'bool' }, { name: 'shares', type: 'uint256' }, { name: 'maxCost', type: 'uint256' }], outputs: [{ name: 'cost', type: 'uint256' }] },
  { type: 'function', name: 'sell', stateMutability: 'nonpayable', inputs: [{ name: 'companyId', type: 'uint256' }, { name: 'kind', type: 'uint8' }, { name: 'longSide', type: 'bool' }, { name: 'shares', type: 'uint256' }, { name: 'minProceeds', type: 'uint256' }], outputs: [{ name: 'proceeds', type: 'uint256' }] },
  { type: 'function', name: 'getPositions', stateMutability: 'view', inputs: [{ name: 'trader', type: 'address' }, { name: 'companyId', type: 'uint256' }], outputs: [{ name: 'result', type: 'tuple[3]', components: [{ name: 'sharesL', type: 'uint128' }, { name: 'sharesS', type: 'uint128' }, { name: 'paidIn', type: 'uint128' }, { name: 'escrow', type: 'uint128' }] }] },
  { type: 'function', name: 'claimableAmount', stateMutability: 'view', inputs: [{ name: 'companyId', type: 'uint256' }, { name: 'trader', type: 'address' }], outputs: [{ name: 'amount', type: 'uint256' }] },
  { type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [{ name: 'companyId', type: 'uint256' }], outputs: [{ name: 'amount', type: 'uint256' }] },
  { type: 'function', name: 'proposeBoost', stateMutability: 'nonpayable', inputs: [{ name: 'companyId', type: 'uint256' }, { name: 'payment', type: 'uint256' }, { name: 'newBs', type: 'uint128[3]' }], outputs: [{ name: 'proposalId', type: 'uint256' }] },
  { type: 'function', name: 'timeAvgPremium', stateMutability: 'view', inputs: [{ name: 'companyId', type: 'uint256' }, { name: 'window', type: 'uint32' }], outputs: [{ name: 'premium', type: 'int256' }] },
  { type: 'function', name: 'settleDocket', stateMutability: 'nonpayable', inputs: [{ name: 'cycleId', type: 'uint256' }], outputs: [{ name: 'paid', type: 'uint256' }] },
  { type: 'function', name: 'getBoostProposal', stateMutability: 'view', inputs: [{ name: 'cycleId', type: 'uint256' }, { name: 'proposalId', type: 'uint256' }], outputs: [{ name: '', type: 'tuple', components: [{ name: 'proposer', type: 'address' }, { name: 'companyId', type: 'uint256' }, { name: 'payment', type: 'uint256' }, { name: 'baselinePremium', type: 'int256' }, { name: 'reward', type: 'uint256' }] }] },
] as const

export const exchangeAbi = [
  { type: 'function', name: 'domainSeparator', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bytes32' }] },
  { type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'cancelOrder', stateMutability: 'nonpayable', inputs: [{ name: 'order', type: 'tuple', components: [
    { name: 'salt', type: 'uint256' }, { name: 'maker', type: 'address' }, { name: 'signer', type: 'address' }, { name: 'taker', type: 'address' },
    { name: 'tokenId', type: 'uint256' }, { name: 'makerAmount', type: 'uint256' }, { name: 'takerAmount', type: 'uint256' }, { name: 'expiration', type: 'uint256' },
    { name: 'nonce', type: 'uint256' }, { name: 'feeRateBps', type: 'uint256' }, { name: 'side', type: 'uint8' }, { name: 'signatureType', type: 'uint8' }, { name: 'signature', type: 'bytes' },
  ] }], outputs: [] },
  { type: 'function', name: 'incrementNonce', stateMutability: 'nonpayable', inputs: [], outputs: [] },
] as const

export const erc20Abi = [
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
] as const
