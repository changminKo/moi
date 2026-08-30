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
    <fieldset className="locale-switch">
      <legend className="sr-only">{t('app.localeSwitchAria')}</legend>
      {option('ko', '한국어')}
      {option('en', 'EN')}
    </fieldset>
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
              S
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
