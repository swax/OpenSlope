import assert from 'node:assert/strict';
import {
  courseLayout,
  importedCourseLayouts,
  isoCourseVisible,
  normalizeCourseLayout,
  registerCourseLayouts,
} from '../src/core/reference/course-layout';

for (const [id, kind, parent] of [
  ['SSX3_ARA1', 'run', 'SSX3_PEAK1'],
  ['SSX3_ERA5', 'run', 'SSX3_PEAK3'],
  ['SSX3_C', 'hub', 'SSX3_PEAK2'],
  ['SSX3_A_ARA1', 'connector', 'SSX3_PEAK1'],
  ['SSX3_PEAK1', 'run-chain', 'SSX3_ALL'],
  ['SSX3_ALL', 'full-mountain', undefined],
] as const) {
  assert.equal(courseLayout(id).MapType, kind);
  assert.equal(courseLayout(id).ParentMap, parent);
  assert.equal(isoCourseVisible(id, false), kind === 'run');
  assert(isoCourseVisible(id, true));
  assert(isoCourseVisible(id, false, [id]), 'Required maps remain visible and loadable');
}
assert(isoCourseVisible('GARI', false));
assert.equal(normalizeCourseLayout({ MapType: 'unknown' }), undefined);
registerCourseLayouts({
  SSX3_ARA1: { MapType: 'run', WorldId: 'ssx-3:bam', SourceSections: ['A_ARA1', 'ARA1', 'ARA1_B'] },
});
assert.deepEqual(importedCourseLayouts(['SSX3_ARA1']).SSX3_ARA1.SourceSections, ['A_ARA1', 'ARA1', 'ARA1_B']);
assert(!normalizeCourseLayout({ MapType: 'run', SourceSections: ['../../escape'] })?.SourceSections);
console.log('COURSE LAYOUT PASS: named-run defaults, advanced types, required-map escape and source composition');
