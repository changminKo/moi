import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PositionsTable } from './positions-table';

afterEach(cleanup);

const held = {
  market: 'US',
  symbol: 'MSFT',
  total: '4',
  available: '3',
  reserved: '1',
  averageCost: '412.5',
};
// What the ledger keeps after the whole position is sold: the quantities fall
// to zero and `average_cost` stays at the history it was bought at, with
// trading-core's ten-place division showing through.
const closed = {
  market: 'US',
  symbol: 'AAPL',
  total: '0',
  available: '0',
  reserved: '0',
  averageCost: '325.9733333333',
};

function holdings() {
  return within(screen.getByRole('region', { name: 'Positions' }));
}

describe('PositionsTable', () => {
  it('lists a symbol that is still held', () => {
    render(<PositionsTable positions={[held]} />);
    const row = holdings().getByRole('row', { name: /MSFT/ });
    expect(within(row).getByText('412.5')).toBeInTheDocument();
  });

  it('keeps a fully-sold symbol out of the holdings table', () => {
    render(<PositionsTable positions={[closed]} />);
    expect(holdings().queryByRole('table')).not.toBeInTheDocument();
    expect(holdings().getByText('No positions yet.')).toBeInTheDocument();
  });

  it('reports a fully-sold symbol as a closed position instead of dropping it', () => {
    render(<PositionsTable positions={[held, closed]} />);
    const closedSection = within(
      screen.getByRole('region', { name: 'Closed positions' }),
    );
    const row = closedSection.getByRole('row', { name: /AAPL/ });
    expect(within(row).getByText('325.97')).toBeInTheDocument();
    expect(closedSection.queryByText('MSFT')).not.toBeInTheDocument();
  });

  it('shows no closed section while every position is still held', () => {
    render(<PositionsTable positions={[held]} />);
    expect(
      screen.queryByRole('region', { name: 'Closed positions' }),
    ).not.toBeInTheDocument();
  });

  it('caps a repeating average cost at two fraction digits', () => {
    render(
      <PositionsTable
        positions={[{ ...held, averageCost: '325.9733333333' }]}
      />,
    );
    const row = holdings().getByRole('row', { name: /MSFT/ });
    expect(within(row).getByText('325.97')).toBeInTheDocument();
    expect(within(row).queryByText('325.9733333333')).not.toBeInTheDocument();
  });
});
