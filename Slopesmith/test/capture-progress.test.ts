// tier: fast
import assert from 'node:assert/strict';
import { CaptureProgress } from '../src/app/state/capture-progress';

const progress = new CaptureProgress();
const a = progress.begin('a.png'), b = progress.begin('b.png');
assert.deepEqual(progress.snapshot().pending, ['a.png', 'b.png']);
b();
assert.deepEqual(progress.snapshot().pending, ['a.png'], 'one finished asset cannot certify other in-flight work');
a(new Error('404'));
const failed = progress.snapshot();
assert.deepEqual(failed.errors, [{ asset: 'a.png', message: '404' }]);
a();
assert.deepEqual(progress.snapshot(), failed, 'duplicate completion cannot change readiness');
const retry = progress.begin('a.png');
assert.deepEqual(progress.snapshot().errors, []);
assert.deepEqual(progress.snapshot().pending, ['a.png']);
retry();
assert.deepEqual(progress.snapshot().pending, []);
assert.ok(progress.snapshot().generation > failed.generation, 'even work that completes between polls invalidates settled frames');
console.log('CAPTURE PROGRESS TESTS PASSED');
