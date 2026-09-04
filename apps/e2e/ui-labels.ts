/**
 * Labels the browser tests match in either language, shared so no surface
 * asserts one spelling on its own.
 *
 * The product default is Korean (`resolveInitialLocale` in
 * `apps/web/src/lib/i18n`). The CI journeys seed English through the
 * paper-system fixture, and the production smoke gets whatever the deployed
 * host serves — nothing seeds a locale there. So anything asserted by both,
 * or asserted as an absence (where the wrong spelling would pass vacuously),
 * is spelled both ways here.
 */

/** The button a failed session bootstrap leaves on the screen (#25). */
export const RETRY_SESSION = /Retry session|세션 다시 시작/u;

/** The wallet panel's accessible name. */
export const WALLET_PANEL = /Wallet|지갑/u;

/** Any rendered money amount, in either currency the product shows. */
export const MONEY = /[₩$]\s?\d[\d,]*/u;
