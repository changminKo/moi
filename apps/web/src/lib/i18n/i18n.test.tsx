import { cleanup, render, screen } from '@testing-library/react';
import { useTranslation } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  changeLocale,
  i18n,
  resolveInitialLocale,
  useAppLocale,
} from './index';
import { en, type MessageKey } from './messages.en';
import { ko } from './messages.ko';

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('message catalogues', () => {
  it('provides a Korean translation for every English key', () => {
    const missing = (Object.keys(en) as MessageKey[]).filter((key) => !ko[key]);
    expect(missing).toEqual([]);
  });

  it('interpolates variables in both languages', async () => {
    expect(
      i18n.t('quote.sparklineSummary', { count: 3, high: '2', low: '1' }),
    ).toBe('Last 3 ticks, high 2, low 1');
    await i18n.changeLanguage('ko');
    expect(
      i18n.t('quote.sparklineSummary', { count: 3, high: '2', low: '1' }),
    ).toBe('최근 3틱, 최고 2, 최저 1');
  });
});

describe('locale resolution', () => {
  it('prefers the lang query, then storage, then Korean', () => {
    expect(resolveInitialLocale('?lang=en')).toBe('en');
    window.localStorage.setItem('moi.locale', 'en');
    expect(resolveInitialLocale('')).toBe('en');
    window.localStorage.clear();
    expect(resolveInitialLocale('')).toBe('ko');
    expect(resolveInitialLocale('?lang=fr')).toBe('ko');
  });
});

function Probe() {
  const { t } = useTranslation();
  const locale = useAppLocale();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="text">{t('app.navTrade')}</span>
      <button type="button" onClick={() => changeLocale('ko')}>
        switch
      </button>
    </div>
  );
}

describe('changeLocale', () => {
  it('switches the rendered language, persists it, and updates <html lang>', async () => {
    render(<Probe />);
    expect(screen.getByTestId('text').textContent).toBe('Trade');
    screen.getByRole('button', { name: 'switch' }).click();
    await screen.findByText('거래');
    expect(screen.getByTestId('locale').textContent).toBe('ko');
    expect(window.localStorage.getItem('moi.locale')).toBe('ko');
    expect(document.documentElement.lang).toBe('ko');
  });
});
