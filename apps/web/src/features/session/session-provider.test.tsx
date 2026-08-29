import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider, useSession } from './session-provider';

const session = {
  sessionId: 'session-1',
  expiresAt: '2026-01-01T00:00:00Z',
  csrfToken: 'csrf-memory',
};

function Probe() {
  const state = useSession();
  if (state.status === 'loading') return <p>Loading session…</p>;
  if (state.status === 'error')
    return (
      <button type="button" onClick={state.retry}>
        Retry session
      </button>
    );
  return <p>Ready {state.session.sessionId}</p>;
}

describe('SessionProvider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('bootstraps exactly once, keeps the csrf token in memory, and exposes loading', async () => {
    const localSet = vi.spyOn(Storage.prototype, 'setItem');
    const post = vi.fn().mockResolvedValue(session);
    const getCsrfToken = vi.fn(() => undefined);
    const apiClient = { post, getCsrfToken };
    render(
      <SessionProvider apiClient={apiClient as never}>
        <Probe />
      </SessionProvider>,
    );
    expect(screen.getByText('Loading session…')).toBeVisible();
    await waitFor(() =>
      expect(screen.getByText('Ready session-1')).toBeVisible(),
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/api/v1/sessions/anonymous', undefined);
    expect(localSet).not.toHaveBeenCalled();
  });

  it('shows a retry action after bootstrap failure', async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(session);
    const apiClient = { post };
    render(
      <SessionProvider apiClient={apiClient as never}>
        <Probe />
      </SessionProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Retry session' }),
      ).toBeVisible(),
    );
    await screen.getByRole('button', { name: 'Retry session' }).click();
    await waitFor(() =>
      expect(screen.getByText('Ready session-1')).toBeVisible(),
    );
    expect(post).toHaveBeenCalledTimes(2);
  });
});
