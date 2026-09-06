import * as THREE from 'three';
import { createBoard, equipmentTextureRegions } from '../src/app/ride/gear';
import { check, failures } from './check';

const boardRegions = equipmentTextureRegions('snowboard');
const skiRegions = equipmentTextureRegions('skis');
const bounds = (points: ReadonlyArray<readonly [number, number]>) => points.reduce(
  (box, [x, y]) => ({ minX: Math.min(box.minX, x), maxX: Math.max(box.maxX, x),
    minY: Math.min(box.minY, y), maxY: Math.max(box.maxY, y) }),
  { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
);

check(boardRegions.length === 2 && boardRegions[0].label === 'TOP' && boardRegions[1].label === 'BOTTOM'
  && bounds(boardRegions[0].points).maxX <= 0.5 && bounds(boardRegions[1].points).minX >= 0.5,
'the snowboard template puts its exact plan silhouette in the left top half and right bottom half');
check(skiRegions.length === 4 && skiRegions.every((region, index) => {
  const box = bounds(region.points);
  return box.minX >= index * 0.25 - 1e-6 && box.maxX <= (index + 1) * 0.25 + 1e-6;
}), 'the ski template keeps left/right front then left/right back inside four ordered vertical strips');

function decks(model: ReturnType<typeof createBoard>): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  model.group.traverse(object => {
    if (object instanceof THREE.Mesh && Array.isArray(object.material) && object.geometry.groups.length === 3) {
      meshes.push(object);
    }
  });
  return meshes;
}

const board = createBoard('snowboard', 'goofy', { edgeColor: '#a1b2c3' });
const boardDecks = decks(board);
const boardMaterials = boardDecks[0]?.material as THREE.MeshLambertMaterial[] | undefined;
const boardUv = boardDecks[0]?.geometry.getAttribute('uv');
check(boardDecks.length === 1 && boardMaterials?.length === 3 && boardMaterials[2].color.getHexString() === 'a1b2c3',
  'a snowboard draws bottom, top, and a separately colourable untextured edge group');
check(!!boardUv && Array.from({ length: boardUv.count }, (_, at) => boardUv.getX(at))
  .every(value => value >= 0 && value <= 1), 'snowboard surface UVs stay normalized across the exact plan bounds');

const skis = createBoard('skis', 'goofy', { edgeColor: '#123456' });
const skiDecks = decks(skis);
check(skiDecks.length === 2 && skiDecks.every(deck => (deck.material as THREE.Material[]).length === 3)
  && skiDecks.every(deck => ((deck.material as THREE.MeshLambertMaterial[])[2]).color.getHexString() === '123456'),
  'both skis share the chosen untextured edge colour while retaining separate mapped surface materials');

board.dispose();
skis.dispose();
if (failures) process.exitCode = 1;
