import { useBoard } from '../lib/board.ts'

export function BoardSmoke() {
  const { rows, error, retry } = useBoard()
  return (
    <main className="page-shell">
      <header className="filing-header">
        <p className="eyebrow">FORM FTC-100 · SEPOLIA TESTNET · CONTINUOUS FILING</p>
        <h1>Fire the CEO</h1>
        <p className="lede">A live register of Robin Hanson’s conditional CEO markets.</p>
      </header>
      {error ? (
        <section className="notice" role="alert">
          <p>The Sepolia register did not answer. Check the connection and retry.</p>
          <button type="button" onClick={retry}>Retry RPC read</button>
        </section>
      ) : null}
      {!rows ? <p className="eyebrow">Reading the public register…</p> : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>ID</th><th>Ticker</th><th>CEO</th><th>OUT mid</th><th>STAY mid</th><th>P(exit)</th><th>Premium</th></tr></thead>
            <tbody>{rows.map((row) => (
              <tr key={row.id}>
                <td>{row.id}</td><td>{row.ticker}</td><td>{row.ceo}</td>
                <td>{row.midOut.toFixed(4)}</td><td>{row.midStay.toFixed(4)}</td>
                <td>{(row.pExit * 100).toFixed(2)}%</td><td>{row.premium >= 0 ? '+' : ''}{(row.premium * 100).toFixed(2)}%</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </main>
  )
}
