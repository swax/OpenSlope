// tier: fast

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const base = readFileSync(resolve(root, 'src/app/styles/base.css'), 'utf8');
const dock = readFileSync(resolve(root, 'src/app/styles/dock.css'), 'utf8');
const responsive = readFileSync(resolve(root, 'src/app/styles/responsive.css'), 'utf8');

assert.match(html, /name="viewport"[^>]*viewport-fit=cover/,
  'the iOS standalone viewport exposes its safe-area insets');
assert.match(base, /--safe-area-top:\s*env\(safe-area-inset-top,\s*0px\)/,
  'the shared layout reads the iPhone top safe area');
assert.match(base, /--bar-h:\s*calc\(var\(--bar-content-h\)\s*\+\s*var\(--safe-area-top\)\)/,
  'bar-dependent chrome clears the safe area as well as the visible toolbar');
assert.match(dock, /padding:\s*var\(--safe-area-top\)[^;]*safe-area-inset-right[^;]*safe-area-inset-left/s,
  'the top dock keeps its controls below the Dynamic Island and inside landscape cutouts');
assert.match(dock, /#dock-right\s*\{[^}]*top:\s*var\(--bar-h\)/s,
  'the right dock follows the safe-area-aware top bar');
assert.match(responsive, /@media \(pointer:\s*coarse\)[\s\S]*--bar-content-h:\s*38px/,
  'touch layouts resize the toolbar content without discarding the safe-area inset');

console.log('mobile safe-area layout checks passed');
