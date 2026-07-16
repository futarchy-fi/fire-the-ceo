import { Link, Route, Routes } from 'react-router-dom'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { BoardPage } from './pages/BoardPage.tsx'
import { CompanyPage } from './pages/CompanyPage.tsx'

function Placeholder({ title }: { title: string }) {
  return (
    <main className="page-shell prose-page">
      <p className="eyebrow">FORM FTC-100 · SEPOLIA TESTNET</p>
      <h1>{title}</h1>
      <p>This filing is being assembled.</p>
    </main>
  )
}

export default function App() {
  return (
    <>
      <header className="site-nav">
        <Link className="wordmark" to="/">FTC / 100</Link>
        <nav aria-label="Primary navigation">
          <Link to="/">The board</Link>
          <Link to="/about">About</Link>
        </nav>
        <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} />
      </header>
      <Routes>
        <Route path="/" element={<BoardPage />} />
        <Route path="/company/:ticker" element={<CompanyPage />} />
        <Route path="/about" element={<Placeholder title="About the proceeding" />} />
        <Route path="*" element={<Placeholder title="Filing not found" />} />
      </Routes>
    </>
  )
}
