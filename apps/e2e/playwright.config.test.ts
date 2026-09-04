import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import config from './playwright.config.js';

// The config is data, so the retry policy is asserted as data: the retry a
// flaky single-origin journey is allowed must not leak into the cross-origin
// project, where a pass on the second attempt would hide exactly the class of
// failure (#25) that project exists to catch.
describe('playwright.config.ts retry policy', () => {
  const projects = config.projects ?? [];
  const project = (name: string) => {
    const found = projects.find((candidate) => candidate.name === name);
    assert.ok(found, `project ${name} is missing`);
    return found;
  };

  it('lets the single-origin projects retry once', () => {
    assert.equal(config.retries, 1);
    for (const name of ['chromium', 'mobile-chromium'])
      assert.equal(project(name).retries, undefined, `${name} must inherit`);
  });

  it('never retries the cross-origin project', () => {
    assert.equal(project('cross-origin-chromium').retries, 0);
  });
});
