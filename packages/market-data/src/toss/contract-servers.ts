/**
 * Server addresses copied verbatim from the pinned contracts
 * (`openapi.json` `servers[0].url`, `asyncapi.json` `servers.production`).
 * A test asserts equality with the contract files, so these never drift.
 */
export const TOSS_CONTRACT_SERVERS = Object.freeze({
  rest: 'https://openapi.tossinvest.com',
  ws: 'wss://openapi-ws.tossinvest.com/ws/v1',
});
