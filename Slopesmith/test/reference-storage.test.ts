// tier: fast
import assert from 'node:assert/strict';
import { setClientProjectId } from '../src/app/net/client';
import { createPersistence, referenceStorageKey, REF_KEY, type StoredRef } from '../src/app/state/storage';

const entries = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
  },
});
const unused = (): never => {
  throw new Error('Only reference persistence is exercised.');
};
let ownerKey: string | null = null;
let reference: StoredRef | null = null;
const { persistRef } = createPersistence({
  getDoc: unused,
  getView: unused,
  getUi: unused,
  getRef: () => reference,
  getRefKey: () => ownerKey,
});

setClientProjectId('mountain-a');
const keyA = referenceStorageKey()!;
setClientProjectId('mountain-b');
const keyB = referenceStorageKey()!;
assert.notEqual(keyA, keyB);
assert.notEqual(keyA, REF_KEY, 'legacy browser-wide reference is never a project key');
entries.set(REF_KEY, JSON.stringify({ level: 'OLD_GLOBAL' }));
assert.equal(entries.get(keyB), undefined, 'new mountains have no saved reference');

ownerKey = keyA;
reference = { level: 'TRICKY_GARI', offset: [120, 0, 30] };
persistRef();
assert.deepEqual(JSON.parse(entries.get(keyA)!), reference);
assert.equal(entries.get(keyB), undefined, 'outgoing view writes cannot contaminate the incoming mountain');
ownerKey = keyB;
reference = { level: 'SSX3_P1', offset: [20, 10, 0] };
persistRef();
reference = null;
persistRef();
assert.equal(entries.get(keyB), undefined);
assert.equal(JSON.parse(entries.get(keyA)!).level, 'TRICKY_GARI', 'clearing one mountain preserves the other');
ownerKey = null;
reference = { level: 'INSPECT_ONLY' };
persistRef();
setClientProjectId(null);
assert.equal(referenceStorageKey(), null);
assert.equal(entries.size, 2, 'a standalone reference view creates no project preference');
assert.equal(JSON.parse(entries.get(REF_KEY)!).level, 'OLD_GLOBAL');
console.log('Reference storage: project isolation, offsets, clearing, teardown ownership and no-project views PASS.');
