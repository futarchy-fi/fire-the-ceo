import { useState } from 'react'

const STORAGE_KEY = 'fire-the-ceo-v2-onboarding'
const steps = [
  { eyebrow: '01 · WHAT THIS IS', title: 'A live fire-the-CEO decision market.', body: 'Traders estimate a company’s stock price in two futures: one where its CEO leaves, and one where the CEO stays. The visible gap is the market’s fire premium.' },
  { eyebrow: '02 · TIMELINE', title: 'Predict first. Settle later.', body: 'Trade until Sep 30. The surviving scenario settles from the official Oct 30 closing price at 21:00 UTC.' },
  { eyebrow: '03 · CALLED-OFF RULE', title: 'The impossible branch is refunded exactly.', body: 'If the CEO stays, every trade premised on departure is called off. If the CEO leaves, every trade premised on retention is called off. Paid-in cash on that branch comes back exactly.' },
  { eyebrow: '04 · PROFIT AND LOSS', title: 'Direction beats mere accuracy.', body: '✓ You profit if your prediction moves the market price closer to the final value. ✕ You lose if it moves it away—even when your number looked close, if the market was closer already.' },
]

export function OnboardingModal() {
  const [open, setOpen] = useState(() => typeof window !== 'undefined' && localStorage.getItem(STORAGE_KEY) !== 'seen')
  const [step, setStep] = useState(0)
  if (!open) return null
  const current = steps[step]
  const finish = () => { localStorage.setItem(STORAGE_KEY, 'seen'); setOpen(false) }
  return (
    <div className="onboarding-backdrop" role="presentation">
      <section className="onboarding-modal" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <p className="eyebrow">EXHIBIT ORIENTATION · {current.eyebrow}</p>
        <h2 id="onboarding-title">{current.title}</h2>
        <p>{current.body}</p>
        <div className="onboarding-progress" aria-label={`Step ${step + 1} of ${steps.length}`}>{steps.map((_, index) => <i key={index} className={index <= step ? 'active' : ''} />)}</div>
        <div className="onboarding-actions">{step > 0 ? <button type="button" onClick={() => setStep((value) => value - 1)}>Back</button> : <span />}{step < steps.length - 1 ? <button className="primary-action" type="button" onClick={() => setStep((value) => value + 1)}>Continue · {step + 2}/4</button> : <button className="primary-action" type="button" onClick={finish}>Enter the exhibit</button>}</div>
      </section>
    </div>
  )
}
