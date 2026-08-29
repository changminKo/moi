import type { Wallet } from '../../lib/api-types';
import { formatDecimal } from '../../lib/format-number';
import './wallet.css';

function displayAmount(currency: Wallet['currency'], value: string): string {
  const amount = formatDecimal(value || '0');
  return currency === 'KRW' ? `₩${amount}` : `$${amount}`;
}

export function WalletSummary({ wallets }: { wallets: readonly Wallet[] }) {
  return (
    <section className="panel" aria-labelledby="wallet-title">
      <h2 id="wallet-title">Wallets</h2>
      <div className="wallet-grid">
        {wallets.map((wallet) => (
          <article key={wallet.currency}>
            <h3>{wallet.currency}</h3>
            <dl>
              <dt>available</dt>
              <dd>{displayAmount(wallet.currency, wallet.available)}</dd>
              <dt>reserved</dt>
              <dd>{displayAmount(wallet.currency, wallet.reserved)}</dd>
              <dt>total</dt>
              <dd>{displayAmount(wallet.currency, wallet.total)}</dd>
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}
