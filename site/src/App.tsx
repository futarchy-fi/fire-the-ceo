import { Link, Route, Routes } from 'react-router-dom'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { BoardPage } from './pages/BoardPage.tsx'
import { CompanyPage } from './pages/CompanyPage.tsx'
import { AboutPage } from './pages/AboutPage.tsx'
import { FaucetBanner } from './components/FaucetBanner.tsx'
import { OnboardingModal } from './components/OnboardingModal.tsx'
import { LiquidityPage } from './pages/LiquidityPage.tsx'
import { GuidePage } from './pages/GuidePage.tsx'
import { DeparturePolicyPage } from './pages/DeparturePolicyPage.tsx'

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
          <Link to="/liquidity">Liquidity</Link>
          <Link to="/guide">Guide</Link>
          <Link to="/about">About</Link>
        </nav>
        <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} />
      </header>
      <FaucetBanner />
      <OnboardingModal />
      <Routes>
        <Route path="/" element={<BoardPage />} />
        <Route path="/company/:ticker" element={<CompanyPage />} />
        <Route path="/about" element={<AboutPage />} />
        <Route path="/liquidity" element={<LiquidityPage />} />
        <Route path="/guide" element={<GuidePage />} />
        <Route path="/mechanism" element={<GuidePage advanced />} />
        <Route path="/departure-policy" element={<DeparturePolicyPage />} />
        <Route path="*" element={<Placeholder title="Filing not found" />} />
      </Routes>
    </>
  )
}
