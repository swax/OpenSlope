import { blankMountain } from '../src/core/doc/mountain';
import { appendBox, boxFromClicks, planBox } from '../src/core/mesh/ops/box';
import { createSubdivisionCage } from '../src/core/mesh/subdivision-object';

export function bendFixture(name = 'BEND', lengthDivisions = 8) {
  const planned = planBox(boxFromClicks([0, 0, 0], [120, 0, 0], [120, 0, 30], 10), {
    divisions: { length: lengthDivisions, width: 1, height: 1 },
  });
  if (!planned.ok) throw new Error(planned.error);
  const box = appendBox(blankMountain(name, 30), planned.plan);
  if (!box.ok) throw new Error(box.error);
  return createSubdivisionCage(box.doc, box.quads, 1);
}
