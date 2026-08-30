import i18next from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import { en } from './messages.en';
import { ko } from './messages.ko';

export type Locale = 'ko' | 'en';
export type { MessageKey } from './messages.en';

const STORAGE_KEY = 'moi.locale';

function isLocale(value: unknown): value is Locale {
  return value === 'ko' || value === 'en';
}

const hasDom = typeof window !== 'undefined';

function readStoredLocale(): Locale | undefined {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isLocale(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolution order: `?lang=` query → localStorage → Korean (product default).
 * Exported for tests.
 */
export function resolveInitialLocale(search: string): Locale {
  const fromQuery = new URLSearchParams(search).get('lang');
  if (isLocale(fromQuery)) return fromQuery;
  return readStoredLocale() ?? 'ko';
}

// Resources are bundled TS modules — no HTTP backend, so the static server
// stays offline-friendly and `connect-src 'self'` is untouched.
void i18next.use(initReactI18next).init({
  resources: { en: { translation: en }, ko: { translation: ko } },
  lng: hasDom ? resolveInitialLocale(window.location.search) : 'ko',
  fallbackLng: 'ko',
  returnNull: false,
  initAsync: false,
  interpolation: { escapeValue: false },
});

if (hasDom) {
  i18next.on('languageChanged', (language) => {
    document.documentElement.lang = language;
  });
  document.documentElement.lang = i18next.language;
}

/** Switches the UI language and persists the explicit choice. */
export function changeLocale(next: Locale): void {
  void i18next.changeLanguage(next);
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage can be unavailable (private mode); the choice just won't stick.
  }
}

/** Narrowed current language for locale-aware helpers outside react-i18next. */
export function useAppLocale(): Locale {
  const { i18n } = useTranslation();
  return i18n.resolvedLanguage === 'en' ? 'en' : 'ko';
}

export { i18next as i18n };
