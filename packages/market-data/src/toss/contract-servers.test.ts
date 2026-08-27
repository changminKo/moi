import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import asyncapi from '../../contracts/toss/asyncapi.json' with { type: 'json' };
import openapi from '../../contracts/toss/openapi.json' with { type: 'json' };
import provenance from '../../contracts/toss/provenance.json' with {
  type: 'json',
};
import { TOSS_CONTRACT_SERVERS } from './contract-servers.js';

describe('TOSS_CONTRACT_SERVERS (B10)', () => {
  it('matches the pinned contract servers byte for byte', () => {
    expect(TOSS_CONTRACT_SERVERS.rest).toBe(openapi.servers[0]?.url);
    const production = asyncapi.servers.production;
    expect(TOSS_CONTRACT_SERVERS.ws).toBe(
      `${production.protocol}://${production.host}${production.pathname}`,
    );
  });
  it('is asserted against contracts whose SHA-256 still matches provenance.json', () => {
    for (const entry of provenance.contracts) {
      const bytes = readFileSync(
        new URL(`../../contracts/toss/${entry.file}`, import.meta.url),
      );
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        entry.sha256,
      );
    }
  });
});
