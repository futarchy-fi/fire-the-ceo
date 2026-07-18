import { formatUnits } from 'viem'
import hansonSources from '../../../data/hanson-sources.json'
import seedTrades from '../../../data/seed-trades.json'
import seedDisclosure from '../../../data/seed-disclosure.json'

const rankingCaveat = hansonSources.key_facts.find((fact) => fact.startsWith('RANKING CAVEAT'))
const operator = '0x693E3FB46Bb36eE43C702FE94f9463df0691b43d'
const sourceLinks = [
  ['Markets for Dumping CEOs (1996)', 'https://mason.gmu.edu/~rhanson/dumpceo.html'],
  ['Shall We Vote on Values, But Bet on Beliefs?', 'https://mason.gmu.edu/~rhanson/futarchy.pdf'],
  ['Published futarchy paper', 'https://mason.gmu.edu/~rhanson/futarchy2013.pdf'],
  ['Decision Markets (1999)', 'https://mason.gmu.edu/~rhanson/decisionmarkets.pdf'],
  ['Logarithmic Market Scoring Rules', 'https://mason.gmu.edu/~rhanson/mktscore.pdf'],
  ['Futarchy Details (2024)', 'https://www.overcomingbias.com/p/futarchy-details'],
  ['Advisory Futarchy (2025)', 'https://www.overcomingbias.com/p/advisory-futarchy'],
  ['Decision Selection Bias', 'https://www.overcomingbias.com/p/decision-selection-bias'],
] as const

function CitationLinks() {
  return <ul className="citation-list">{sourceLinks.map(([label, href]) => <li key={href}><a href={href} target="_blank" rel="noreferrer">{label} ↗</a></li>)}</ul>
}

export function AboutPage() {
  return (
    <main className="page-shell about-page">
      <header className="filing-header about-header">
        <p className="eyebrow">FORM FTC-A · STATEMENT OF MECHANISM AND POLICY</p>
        <h1>About the proceeding</h1>
        <p className="lede">A public Sepolia trial of Robin Hanson’s proposal to let informed traders tell a board what its euphemisms cannot.</p>
      </header>

      <section className="about-section about-intro">
        <div className="section-number">01</div>
        <article>
          <p className="eyebrow">HANSON’S VISION · 1996–</p>
          <h2>Let the price name the cost of the chief executive.</h2>
          <p>Hanson proposed a separate market for each stock whose trades are called off when the CEO does not leave. His later formulation pairs two conditional stock-value markets—CEO out and CEO kept—so the difference states the market’s estimate of the decision.</p>
          <blockquote>“The OldTek corporate charter might say that if the dump-the-CEO price were clearly higher than the keep-the-CEO stock price, the board must dump him within the next quarter. (The price might be deemed ‘clearly higher’ if the dump-the-CEO bid price were above the keep-the-CEO ask price for 90% of the last week of a quarter.)”</blockquote>
          <p>This trial uses mid-price snapshots as the published operational proxy: FIRE if the premium is positive in at least 90% of snapshots over the trailing seven days, with at least 20 observations; KEEP if it is non-positive in at least 90%; otherwise WATCH. No trading means no signal.</p>
          <CitationLinks />
        </article>
      </section>

      <section className="about-section">
        <div className="section-number">02</div>
        <article>
          <p className="eyebrow">CALLED-OFF BETS</p>
          <h2>The losing condition is void, not wrong.</h2>
          <div className="mechanism-steps">
            <div><strong>CEO LEAVES</strong><p>Traders price the company’s post-horizon share value if the named CEO departs.</p></div>
            <div><strong>CEO STAYS</strong><p>Traders price the same settlement if the named CEO remains.</p></div>
            <div><strong>CALL OFF</strong><p>Only the condition that happens settles. The other market returns each trader’s paid-in cash exactly; escrowed sale proceeds cancel.</p></div>
          </div>
          <p>Cash never leaves the contract between trade and resolution. Buys add paid-in collateral; sells create an internal escrow claim. That invariant makes “null and void” literal rather than rhetorical. Every market is continuously quoted by an explicitly subsidized LMSR.</p>
        </article>
      </section>

      <section className="about-section policy-section">
        <div className="section-number">03</div>
        <article>
          <p className="eyebrow">PUBLISHED RESOLUTION POLICY</p>
          <h2>Condition and settlement</h2>
          <p>The departure condition is true when, on or before the horizon, the named CEO’s office ceases to be held by that person, or the company publicly and irrevocably announces that the person will cease to hold it. Termination, resignation, retirement, death, and an announced transition with a named successor or interim count.</p>
          <p>Settlement price = official closing price on the settlement date from the primary exchange, adjusted for splits; extraordinary cash distributions and M&amp;A: if shares cease trading before settlement (acquisition), the settlement price is final deal consideration per share; spin-offs add per-share value of distributed entities.</p>
          <p>Oracle = operator key on testnet, 48 h dispute window, all resolutions posted with a source link in the resolution transaction calldata and shown in the UI.</p>
        </article>
      </section>

      <section className="about-section">
        <div className="section-number">04</div>
        <article>
          <p className="eyebrow">INSIDER POLICY</p>
          <h2>Information is invited; conflicts are disclosed.</h2>
          <p>Hanson’s design allows and encourages informed insiders to trade. A production market should protect outsiders’ anonymity while identifying trades by the CEO, directors, officers, advisers, and anyone trading for them; the CEO’s compensation and market position should be public.</p>
          <p>Sepolia provides pseudonymous wallets, not verified identities. This trial cannot enforce insider status. Anyone publicly connected to a company is asked to disclose the controlling wallet before trading. Undisclosed conflicts make a price less credible and may be annotated in the public record.</p>
        </article>
      </section>

      <section className="about-section disclosure-section">
        <div className="section-number">05</div>
        <article>
          <p className="eyebrow">SEED-TRADE DISCLOSURE · OPERATOR {operator}</p>
          <h2>Launch positions</h2>
          <p>These small, sourced positions prevent a uniformly empty demonstration board. They are not independent market evidence and must not be read as such.</p>
          <div className="seed-table-wrap">
            <table className="seed-table">
              <thead><tr><th>Company</th><th>Market</th><th>Side</th><th>Shares</th><th>Rationale</th></tr></thead>
              <tbody>{seedTrades.map((trade, index) => {
                const disclosure = seedDisclosure[index]
                return <tr key={`${trade.ticker}-${trade.kind}-${index}`}>
                  <td>{trade.ticker}</td><td>{['CEO leaves', 'CEO stays', 'Departure chance'][trade.kind] ?? trade.kind}</td><td>{trade.longSide ? 'Higher' : 'Lower'}</td>
                  <td>{Number(formatUnits(BigInt(disclosure?.shares ?? trade.shares), 18)).toLocaleString('en-US', { maximumFractionDigits: 0 })}</td><td>{disclosure?.rationale ?? 'Operator seed position; rationale not recorded.'}</td>
                </tr>
              })}</tbody>
            </table>
          </div>
        </article>
      </section>

      <section className="about-section caveat-section">
        <div className="section-number">06</div>
        <article>
          <p className="eyebrow">RANKING CAVEAT</p>
          <h2>A faithful extrapolation, honestly labelled.</h2>
          <p>{rankingCaveat?.replace('RANKING CAVEAT (epistemic flag): ', '')}</p>
          <p>The cross-company scoreboard is therefore a faithful extrapolation of Hanson’s per-company proposal—not a feature we can quote him proposing verbatim.</p>
        </article>
      </section>

      <section className="testnet-disclaimer">
        <p className="eyebrow">TESTNET DISCLAIMER</p>
        <h2>This is a mechanism trial, not an investment market.</h2>
        <p>pUSD has no monetary value. Sepolia trades provide no exposure to any company, security, share price, executive outcome, or legal claim. Play money removes the real financial incentive at the heart of information markets, so this site demonstrates the mechanism and its public record—not reliable investment evidence or a recommendation to trade, vote, retain, or dismiss anyone.</p>
      </section>
    </main>
  )
}
