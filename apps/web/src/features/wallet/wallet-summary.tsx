import type { Wallet } from '../../lib/api-types';
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
              <dd>{wallet.available}</dd>
              <dt>reserved</dt>
              <dd>{wallet.reserved}</dd>
              <dt>total</dt>
              <dd>{wallet.total}</dd>
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}
