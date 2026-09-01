import { redact } from '../transport/redact.js';
import type { BacktestReport } from './engine.js';

/**
 * The report, as text an operator reads.
 *
 * Two things about it are obligations rather than presentation.
 *
 * **The fee header.** Design §8.3 requires the report to say, at the top, that
 * the fees it charged came from the plan and not from the ledger — there is no
 * public fee endpoint (§1 row 13), so the schedule is an assumption, and a
 * strategy whose edge is thinner than the difference is a strategy this report
 * cannot judge. It names the schedule versions so the assumption is checkable
 * rather than merely disclaimed.
 *
 * **The masking.** §7.4 puts the runner's cookie and CSRF patterns behind one
 * masker and says explicitly that they must not reach a backtest artifact. A
 * report is built from reasons and refusals that came from strategy code and
 * from the gate, so nothing here *should* carry one — and "should" is why the
 * whole rendered document goes through `redact` anyway. A masker that only runs
 * where someone remembered to call it is not a masker.
 */

const heading = (title: string): string =>
  `\n${title}\n${'-'.repeat(title.length)}`;

export function formatBacktestReport(report: BacktestReport): string {
  const lines: string[] = [
    'Backtest report',
    '===============',
    '',
    `Fees were charged from the plan's own schedule (${report.feeScheduleVersions.join(', ')}),`,
    "not the ledger's. There is no public fee endpoint, so every fee below is an",
    'assumption; a strategy whose edge is narrower than the difference between',
    'this schedule and the real one is a strategy this report cannot judge.',
  ];

  if (report.ticks === 0) {
    lines.push(
      '',
      'This plan replayed no ticks, so there is nothing to report.',
    );

    return redact(lines.join('\n'));
  }

  lines.push(
    heading('Series'),
    `${report.ticks} ticks from ${String(report.from)} to ${String(report.to)}`,
    heading('Decisions'),
    `placed ${report.counts.placed}  refused ${report.counts.refused}  rejected ${report.counts.rejected}  cancelled ${report.counts.cancelled}  noop ${report.counts.noop}`,
  );

  for (const tally of report.perStrategy) {
    lines.push(
      `  ${tally.name}: placed ${tally.placed}  refused ${tally.refused}  rejected ${tally.rejected}  noop ${tally.noop}`,
    );
  }

  lines.push(heading('Fills'));

  if (report.fills.length === 0) {
    lines.push('  none');
  }

  for (const fill of report.fills) {
    lines.push(
      `  ${fill.at}  ${fill.side} ${fill.quantity} ${fill.market}:${fill.symbol} @ ${fill.price} (${fill.type}, fee ${fill.fee} ${fill.currency})`,
    );
  }

  lines.push(heading('Realised PnL'));

  if (report.realisedPnl.length === 0) {
    lines.push('  none');
  }

  for (const realised of report.realisedPnl) {
    lines.push(
      `  ${realised.instrument}: ${realised.amount} ${realised.currency}`,
    );
  }

  lines.push(
    heading('Fees paid'),
    ...report.feesPaid.map((paid) => `  ${paid.amount} ${paid.currency}`),
    heading('Closing balances'),
    ...report.finalWallets.map(
      (wallet) =>
        `  ${wallet.currency}: ${wallet.available} available, ${wallet.reserved} reserved`,
    ),
  );

  lines.push(heading('Closing positions'));

  if (report.finalPositions.length === 0) {
    lines.push('  flat');
  }

  for (const position of report.finalPositions) {
    lines.push(
      `  ${position.market}:${position.symbol}: ${position.total} held (${position.available} available) at ${position.averageCost}`,
    );
  }

  if (report.openOrders.length > 0) {
    lines.push(
      heading('Still resting at the end'),
      ...report.openOrders.map(
        (order) =>
          `  ${order.id}: ${order.side} ${order.quantity} ${order.market}:${order.symbol} @ ${String(order.limitPrice)}`,
      ),
    );
  }

  if (report.refusals.length > 0) {
    lines.push(
      heading('Refused by the risk gate'),
      ...report.refusals.map(
        (refusal) =>
          `  ${refusal.at}  ${refusal.strategy} wanted ${refusal.side} (${refusal.reason}): ${refusal.refusal}`,
      ),
    );
  }

  if (report.rejections.length > 0) {
    lines.push(
      heading('Rejected by the exchange'),
      ...report.rejections.map(
        (rejection) =>
          `  ${rejection.at}  ${rejection.strategy} ${rejection.side} ${rejection.code}: ${rejection.reason}`,
      ),
    );
  }

  return redact(lines.join('\n'));
}
