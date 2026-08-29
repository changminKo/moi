import { describe } from 'vitest';
import {
  CONTRACT_OPEN_ORDER_ID,
  CONTRACT_QUOTE_ID,
  CONTRACT_SESSION_ID,
  CONTRACT_TERMINAL_ORDER_ID,
  createFakeBroker,
  createPaperAccountFake,
  runBrokerContract,
} from './broker-contract.js';

describe('broker contract (deterministic in-memory fake)', () => {
  runBrokerContract(() => ({
    broker: createFakeBroker(createPaperAccountFake()),
    sessionId: CONTRACT_SESSION_ID,
    terminalOrderId: CONTRACT_TERMINAL_ORDER_ID,
    openOrderId: CONTRACT_OPEN_ORDER_ID,
    exchangeQuoteId: CONTRACT_QUOTE_ID,
  }));
});
