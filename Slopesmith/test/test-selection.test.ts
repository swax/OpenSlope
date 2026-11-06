// tier: fast
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { browserSmoke, matchesEnvironment, matchesFilter, testEnvironment, unfinishedTests } from './test-selection';

assert(matchesFilter('map-library-browser.test.ts', 'map-library-browser.test.ts'));
assert(!matchesFilter('game-map-library-browser.test.ts', 'map-library-browser.test.ts'));
assert(matchesFilter('map-library-browser.test.ts', 'test/map-library-browser.test.ts'));
assert(matchesFilter('game-map-library-browser.test.ts', 'map-library'));
assert.equal(testEnvironment('// environment: dom\n'), 'dom');
assert.equal(testEnvironment("import { chromium } from 'playwright-core';"), 'browser');
assert.equal(testEnvironment("import * as playwright from 'playwright-core';"), 'browser');
assert.equal(testEnvironment("import type { Browser } from 'playwright-core';"), 'node');
assert.equal(testEnvironment("import { testApi } from './http-test-support';"), 'api');
assert.deepEqual(
  [
    ...unfinishedTests({
      outcomes: [
        { label: 'passed', ok: true },
        { label: 'failed', ok: false },
      ],
      running: ['interrupted'],
      pending: ['not-started'],
    }),
  ],
  ['failed', 'interrupted', 'not-started'],
);
assert.throws(() => testEnvironment("// environment: node\nimport { chromium } from 'playwright-core';"));
assert.throws(() => testEnvironment('// environment: brwoser'));
const files = readdirSync(new URL('.', import.meta.url)).filter(name => name.endsWith('.test.ts'));
let browser = 0,
  nonBrowser = 0,
  smoke = 0;
for (const file of files) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const environment = testEnvironment(source);
  if (matchesEnvironment(environment, 'browser')) browser++;
  if (matchesEnvironment(environment, 'non-browser')) nonBrowser++;
  if (browserSmoke(source)) {
    assert.equal(environment, 'browser', `${file}: smoke markers must launch a real browser`);
    smoke++;
  }
}
assert.equal(browser + nonBrowser, files.length, 'no discovered check falls between lanes');
assert(browser > 0 && nonBrowser > 0 && smoke > 0, 'all lanes contain checks');
console.log(`PASS test selection: ${nonBrowser} Node/DOM/API, ${browser} browser, ${smoke} browser smoke`);
