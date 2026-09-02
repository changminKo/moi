import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PositionsTable } from './positions-table';
import type { RealizedPnlSummary } from './realized-pnl';

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

function closedPositions() {
  return within(screen.getByRole('region', { name: 'Closed positions' }));
}

const realized = (
  bySymbol: Record<string, { realizedPnl: string; currency: 'KRW' | 'USD' }>,
  unavailable: readonly string[] = [],
): RealizedPnlSummary => ({
  bySymbol: new Map(Object.entries(bySymbol)),
  totals: [],
  unavailable: new Set(unavailable),
});

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

  describe('realized P&L column', () => {
    it('shows what a partly-sold holding has realized so far, in its currency', () => {
      render(
        <PositionsTable
          positions={[held]}
          realized={realized({
            MSFT: { realizedPnl: '12.5', currency: 'USD' },
          })}
        />,
      );
      const row = holdings().getByRole('row', { name: /MSFT/ });
      expect(within(row).getByText('$12.5')).toHaveClass('pnl-gain');
    });

    it("shows a closed position's realized loss with the sign ahead of the currency", () => {
      render(
        <PositionsTable
          positions={[closed]}
          realized={realized({
            AAPL: { realizedPnl: '-3.256', currency: 'USD' },
          })}
        />,
      );
      const row = closedPositions().getByRole('row', { name: /AAPL/ });
      expect(within(row).getByText('-$3.26')).toHaveClass('pnl-loss');
    });

    it('groups a KRW figure and leaves zero unstyled', () => {
      render(
        <PositionsTable
          positions={[
            { ...held, symbol: '005930' },
            { ...closed, symbol: '000660' },
          ]}
          realized={realized({
            '005930': { realizedPnl: '0', currency: 'KRW' },
            '000660': { realizedPnl: '1250000', currency: 'KRW' },
          })}
        />,
      );
      const heldRow = holdings().getByRole('row', { name: /005930/ });
      const zero = within(heldRow).getByText('₩0');
      expect(zero).not.toHaveClass('pnl-gain');
      expect(zero).not.toHaveClass('pnl-loss');
      const closedRow = closedPositions().getByRole('row', { name: /000660/ });
      expect(within(closedRow).getByText('₩1,250,000')).toBeInTheDocument();
    });

    it('shows a dash for a symbol whose fills could not be folded', () => {
      render(
        <PositionsTable positions={[held]} realized={realized({}, ['MSFT'])} />,
      );
      const row = holdings().getByRole('row', { name: /MSFT/ });
      expect(
        within(row).getByRole('cell', { name: 'Realized P&L unavailable' }),
      ).toHaveTextContent('—');
    });

    it('shows a dash when no realized figure was supplied at all', () => {
      render(<PositionsTable positions={[held]} />);
      const row = holdings().getByRole('row', { name: /MSFT/ });
      expect(within(row).getAllByText('—')).toHaveLength(1);
    });
  });
});
