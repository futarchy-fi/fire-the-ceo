export type Verdict = 'FIRE' | 'KEEP' | 'WATCH'

export function SignalBadge({ verdict, large = false }: { verdict: Verdict; large?: boolean }) {
  return (
    <span className={`verdict verdict--${verdict.toLowerCase()} ${large ? 'verdict--large' : ''}`}>
      {verdict}
    </span>
  )
}
