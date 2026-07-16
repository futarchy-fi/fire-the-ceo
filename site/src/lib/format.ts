export const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function signedPercent(value: number, digits = 2): string {
  const sign = value >= 0 ? '+' : '−'
  return `${sign}${Math.abs(value * 100).toFixed(digits)}%`
}

export function percent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`
}

export function compactBillions(value: number): string {
  return value >= 1000 ? `$${(value / 1000).toFixed(2)}T` : `$${value.toFixed(value < 100 ? 1 : 0)}B`
}

export function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(timestamp * 1000))
}
