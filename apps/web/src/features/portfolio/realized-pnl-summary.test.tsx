import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RealizedPnlSummary } from './realized-pnl-summary';

afterEach(cleanup);

describe('RealizedPnlSummary', () => {
  it('states the session total per settlement currency', () => {
    render(
      <RealizedPnlSummary
        totals={[
          { currency: 'KRW', realizedPnl: '1250000' },
          { currency: 'USD', realizedPnl: '-3.256' },
        ]}
      />,
    );
    const summary = screen.getByRole('region', { name: 'Realized P&L' });
    expect(summary).toHaveTextContent('₩1,250,000');
    expect(summary).toHaveTextContent('-$3.26');
  });

  it('renders nothing while no fill has settled in any currency', () => {
    const { container } = render(<RealizedPnlSummary totals={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
