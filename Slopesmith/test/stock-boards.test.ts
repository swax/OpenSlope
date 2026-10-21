// tier: fast
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import {
  StockBoardSelection,
  STOCK_BOARD_DESIGNS,
  isStockBoardId,
  stockBoardUrl,
} from '../src/core/equipment/stock-boards';
import { createBoard } from '../src/app/ride/gear';
import { createRiderPose } from '../src/app/ride/pose';

for (let i = 0; i < STOCK_BOARD_DESIGNS.length; i++) {
  const board = new StockBoardSelection(() => (i + 0.1) / 4);
  assert.equal(board.design.id, STOCK_BOARD_DESIGNS[i].id);
  assert(isStockBoardId(board.design.id));
  const png = readFileSync(new URL(`../public/equipment/boards/${board.design.id}.png`, import.meta.url));
  assert.equal(png.readUInt32BE(0), 0x89504e47);
  assert.equal(png.readUInt32BE(16), png.readUInt32BE(20), 'top/base atlas is square');
  assert.equal(png.readUInt32BE(16) % 2, 0, 'two equal panels have integer pixel widths');
  assert(stockBoardUrl(board.design.id).startsWith('/equipment/boards/'));
  const old = board.design.id;
  board.renew();
  assert.notEqual(board.design.id, old, 'replacement avoids an immediate repeat');
}
assert(!isStockBoardId('../../other'));
const selection = new StockBoardSelection(() => 0, 'contour');
let changes = 0;
const unsubscribe = selection.subscribe(() => changes++);
const mounted = createBoard('snowboard', 'goofy', undefined, selection);
const parked = createBoard('snowboard', 'goofy', undefined, selection);
const edgeOf = (group: THREE.Group) =>
  (group.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial[]>).material[2];
selection.renew();
assert.equal(changes, 1);
assert.equal(edgeOf(mounted.group).color.getHex(), selection.design.edge);
assert.equal(edgeOf(parked.group).color.getHex(), selection.design.edge, 'mounted and loose models share identity');
mounted.setAppearance({ edgeColor: '#123456' });
selection.renew();
assert.equal(edgeOf(mounted.group).color.getHex(), 0x123456, 'account appearance overrides stock');
const keep = selection.design.id;
const pose = createRiderPose({ scene: new THREE.Scene(), riderModel: 'procedural', stockBoard: selection });
pose.setSnowboardStance('standard');
pose.setGear('skis');
pose.setGear('snowboard');
pose.setEquipmentAppearance({});
assert.equal(selection.design.id, keep, 'stance/gear/presentation rebuilds retain the physical board choice');
pose.dispose();
mounted.dispose();
parked.dispose();
unsubscribe();
const oldChanges = changes;
selection.renew();
assert.equal(changes, oldChanges);
console.log('STOCK BOARDS TEST PASSED (four atlases, random selection, shared identity, overrides and rebuilds)');
