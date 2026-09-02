import { useTranslation } from 'react-i18next';
import type { Wallet } from '../../lib/api-types';
import { withCurrency } from '../../lib/currency';
import {
  capFractionDigits,
  formatDecimal,
  MONEY_DISPLAY_FRACTION_DIGITS,
} from '../../lib/format-number';
import './wallet.css';

function displayAmount(currency: Wallet['currency'], value: string): string {
  return withCurrency(
    currency,
    formatDecimal(
      capFractionDigits(value || '0', MONEY_DISPLAY_FRACTION_DIGITS),
    ),
  );
}

export function WalletSummary({ wallets }: { wallets: readonly Wallet[] }) {
  const { t } = useTranslation();
  return (
    <section className="panel" aria-labelledby="wallet-title">
      <h2 id="wallet-title">{t('wallet.title')}</h2>
      <div className="wallet-grid">
        {wallets.map((wallet) => (
          <article key={wallet.currency}>
            <h3>{wallet.currency}</h3>
            <dl>
              <dt>{t('wallet.available')}</dt>
              <dd>{displayAmount(wallet.currency, wallet.available)}</dd>
              <dt>{t('wallet.reserved')}</dt>
              <dd>{displayAmount(wallet.currency, wallet.reserved)}</dd>
              <dt>{t('wallet.total')}</dt>
              <dd>{displayAmount(wallet.currency, wallet.total)}</dd>
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}
