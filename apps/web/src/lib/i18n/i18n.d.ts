import type { en } from './messages.en';

// Typed message keys: a `t('unknown.key')` anywhere in the app fails
// `pnpm typecheck` instead of rendering the raw key at runtime.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof en };
    returnNull: false;
  }
}
