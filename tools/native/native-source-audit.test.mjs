import assert from 'node:assert/strict';
import test from 'node:test';
import { auditNativeSources } from './native-source-audit.mjs';

test('rejects legacy dependencies, identifiers and prose in Native sources', () => {
  for (const text of [
    'SSX-Library',
    'ssx_library',
    'SSX Library',
    'ssxlibrary',
    'Snowknife',
    'TrickyLevelInterface',
    'OldShapeHandler',
    'GenerateRawPoints',
    'ProcessedToMidEq1',
  ]) {
    assert.equal(auditNativeSources({ 'Native/example.cpp': `// ${text}` }).length, 1, text);
  }
});
test('retains specified protocol identifiers and shared map fields', () => {
  assert.deepEqual(
    auditNativeSources({
      'Native/example.cpp':
        '// ISO9660 C0FB BIGF RefPack SHPS PBD\n// PatchName UVPoints Points SurfaceType TrickOnlyPatch TexturePath LightmapID',
    }),
    [],
  );
});
test('checks paths and reports the actual source line', () => {
  assert.deepEqual(auditNativeSources({ 'Native/example.cpp': 'ordinary code\r\n// SSX-Library' }), [
    'Native/example.cpp:2: legacy component reference or decoder identifier',
  ]);
  assert.equal(auditNativeSources({ 'Native/SSX-Library/dependency.cmake': 'ordinary code' }).length, 1);
});
