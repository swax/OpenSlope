import { blankMountain } from '../src/core/doc/mountain';
import { appendMeshIds } from '../src/core/doc/ids';
import type { ProjectBundle } from '../src/core/project/transfer';

export function editableReferenceFixture(name = 'REFERENCE_SOURCE'): ProjectBundle {
  const document = blankMountain(name, 30);
  document.vertices = [0, 0, 0, 60, 0, 0, 0, 0, 60, 60, 0, 60];
  document.quads = [[0, 1, 2, 3]];
  Object.assign(document, appendMeshIds(document, 4, 1));
  document.quadTex = { 0: 'Custom/shared.png' };
  document.quadOrient = { 0: { rot: 1, mirror: true } };
  document.autoAiPaths = false;
  document.models = [
    {
      id: 'model:0000',
      name: 'Authored sign',
      anchor: [0, 0, 0],
      vertices: [0, 0, 0, 8, 0, 0, 0, 10, 0, 8, 10, 0],
      quads: [[0, 1, 2, 3]],
      texture: 'Custom/shared.png',
    },
  ];
  document.props = [
    {
      id: 'prop:0000',
      level: '@models',
      model: 0,
      name: 'Authored sign',
      pos: [20, 0, 20],
      yaw: 25,
      pitch: 10,
      scale: 2,
    },
  ];
  return {
    kind: 'slopesmith-project',
    schema: 1,
    name,
    revision: 1,
    takenAt: new Date(0).toISOString(),
    document,
    assets: [],
    blobs: {},
  };
}
