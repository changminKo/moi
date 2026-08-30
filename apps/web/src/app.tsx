import { useTranslation } from 'react-i18next';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { SystemBanner } from './features/system/system-banner';
import { SystemStatusProvider } from './features/system/system-status-provider';
import { changeLocale, type Locale, useAppLocale } from './lib/i18n';
import { PortfolioPage } from './pages/portfolio-page';
import { TradePage } from './pages/trade-page';

function LocaleSwitch() {
  const { t } = useTranslation();
  const locale = useAppLocale();
  const option = (value: Locale, label: string) => (
    <button
      type="button"
      className="locale-option"
      aria-pressed={locale === value}
      onClick={() => changeLocale(value)}
    >
      {label}
    </button>
  );
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: fieldset/legend is for
          grouped form controls; this is a two-button toggle, so the group
          role carries the accessible name instead. */}
      <div
        className="locale-switch"
        role="group"
        aria-label={t('app.localeSwitchAria')}
      >
        {option('ko', '한국어')}
        {option('en', 'EN')}
      </div>
    </>
  );
}

export function App() {
  const { t } = useTranslation();
  return (
    <SystemStatusProvider>
      <div className="app-shell">
        <header className="site-header">
          <a className="brand" href="/trade" aria-label={t('app.brandAria')}>
            <span className="brand-mark" aria-hidden="true">
              M
            </span>
            <span>Moi</span>
          </a>
          <nav aria-label={t('app.navAria')}>
            <NavLink
              className={({ isActive }) =>
                isActive ? 'nav-link active' : 'nav-link'
              }
              to="/trade"
            >
              {t('app.navTrade')}
            </NavLink>
            <NavLink
              className={({ isActive }) =>
                isActive ? 'nav-link active' : 'nav-link'
              }
              to="/portfolio"
            >
              {t('app.navPortfolio')}
            </NavLink>
          </nav>
          <span className="environment-label">SIM / READY</span>
          <LocaleSwitch />
        </header>
        <main id="main-content">
          <SystemBanner />
          <Routes>
            <Route path="/trade" element={<TradePage />} />
            <Route path="/portfolio" element={<PortfolioPage />} />
            <Route path="*" element={<Navigate replace to="/trade" />} />
          </Routes>
        </main>
      </div>
    </SystemStatusProvider>
  );
}
