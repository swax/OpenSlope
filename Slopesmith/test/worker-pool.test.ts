// tier: fast

import assert from 'node:assert/strict';
import { workerPoolSizes } from '../src/server/worker-pool';

assert.deepEqual(workerPoolSizes(1, {}), { parallelism: 1, reference: 1, document: 1 },
  'one-CPU hosts retain one isolated worker for each workload');
assert.deepEqual(workerPoolSizes(2, {}), { parallelism: 2, reference: 1, document: 1 },
  'two-CPU hosts overcommit only when both isolated workloads coincide');
assert.deepEqual(workerPoolSizes(4, {}), { parallelism: 4, reference: 2, document: 1 },
  'four-CPU hosts share three worker slots and leave one CPU for the event loop');
assert.deepEqual(workerPoolSizes(8, {}), { parallelism: 8, reference: 4, document: 2 },
  'larger hosts retain the bounded per-workload maxima');

const requested = workerPoolSizes(4, {
  SLOPESMITH_REFERENCE_WORKERS: '4',
  SLOPESMITH_DOCUMENT_WORKERS: '2',
});
assert.equal(requested.reference + requested.document, 3,
  'explicit pool limits are clamped to the host-wide budget');
assert.equal(requested.document, 2,
  'an explicit document reserve wins before reference concurrency');
assert.deepEqual(workerPoolSizes(4, {
  SLOPESMITH_REFERENCE_WORKERS: 'zero',
  SLOPESMITH_DOCUMENT_WORKERS: '-1',
}), workerPoolSizes(4, {}), 'invalid worker overrides fall back to the safe defaults');

console.log('WORKER POOL TESTS PASSED');
