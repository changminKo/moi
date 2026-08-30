import '@testing-library/jest-dom/vitest';
import { i18n } from '../lib/i18n';

// Unit tests assert the English vocabulary regardless of the Korean default.
await i18n.changeLanguage('en');
