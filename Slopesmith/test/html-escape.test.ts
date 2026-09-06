// tier: fast

import assert from 'node:assert/strict';
import { escapeHtml } from '../src/app/ui/components/html-escape';

assert.equal(escapeHtml('Custom/snow_01.png'), 'Custom/snow_01.png',
  'an ordinary tile ref passes through unchanged');
assert.equal(escapeHtml('<img src=x onerror="steal()">'),
  '&lt;img src=x onerror=&quot;steal()&quot;&gt;',
  'markup-shaped text is neutralised before it reaches innerHTML');
assert.equal(escapeHtml("Bob's & Co"), 'Bob&#39;s &amp; Co',
  'quotes and ampersands are escaped so attribute and entity contexts are safe too');
assert.equal(escapeHtml(42), '42', 'non-strings are stringified rather than thrown on');
assert.equal(escapeHtml(undefined), 'undefined', 'a missing value renders as text, never as markup');

console.log('HTML ESCAPE: PASS');
