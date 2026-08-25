import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { TradePage } from './pages/trade-page';

function PortfolioPlaceholder() {
  return (
    <section className="page-intro" aria-labelledby="portfolio-title">
      <p className="eyebrow">ACCOUNT / 02</p>
      <h1 id="portfolio-title">Know your position.</h1>
      <p className="lede">
        Your paper balance, open risk, and performance will live here.
      </p>
      <div className="empty-state">
        No positions yet. The next good trade starts with a plan.
      </div>
    </section>
  );
}

export function App() {
  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="/trade" aria-label="Skipjack 거래로 이동">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <span>Skipjack</span>
        </a>
        <nav aria-label="주요 메뉴">
          <NavLink
            className={({ isActive }) =>
              isActive ? 'nav-link active' : 'nav-link'
            }
            to="/trade"
          >
            거래
          </NavLink>
          <NavLink
            className={({ isActive }) =>
              isActive ? 'nav-link active' : 'nav-link'
            }
            to="/portfolio"
          >
            포트폴리오
          </NavLink>
        </nav>
        <span className="environment-label">SIM / READY</span>
      </header>
      <main id="main-content">
        <Routes>
          <Route path="/trade" element={<TradePage />} />
          <Route path="/portfolio" element={<PortfolioPlaceholder />} />
          <Route path="*" element={<Navigate replace to="/trade" />} />
        </Routes>
      </main>
    </div>
  );
}
