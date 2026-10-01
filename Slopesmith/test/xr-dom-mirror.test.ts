// tier: fast

// The wrist EDIT palette's DOM mirror (docs/068), checked without a browser. The rasterizer itself needs a real
// one (`?xrpanels=1` shows it); what is pinned here is the geometry and bookkeeping around it, where a quiet
// mistake would put a click on the wrong control or drop the CSS a panel needs:
//  - the CSS filter keeps every rule that COULD match (negations and alternatives never make a class required);
//  - a texture UV maps back to the page point it was drawn from, per part;
//  - dropdown stepping skips disabled options and wraps;
//  - the palette is laid out around the watch, and a mode switch moves nothing above or beside the watch;
//  - the placement bar's steps move the seat in grip axes and reset to the defaults, and its buttons hit-test;
//  - the `data-xr-edit` keys the palette crops to are still the ones the panels carry.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  intersectRect, mirrorUvToClient, nextSelectableIndex, paddedPixelRect, partUvRect, ruleMayApply, selectorRequirements,
  splitSelectorList, unionRect,
} from '../src/app/ride/xr/dom-mirror';
import * as THREE from 'three';
import { layoutAroundWatch, XR_EDIT_MIRRORS, XR_EDIT_PALETTE_SEAT } from '../src/app/ride/xr/edit-palette';
import { XR_WATCH_HEIGHT, XR_WATCH_POSITION, XR_WATCH_TILT, XR_WATCH_WIDTH } from '../src/app/ride/xr/hud';
import {
  paletteSeatActionAt, samePaletteSeat, stepPaletteSeat, XR_PALETTE_SEAT_BUTTONS,
} from '../src/app/ride/xr/palette-seat';

// ---- the CSS filter
assert.deepEqual(splitSelectorList('.a, .b:is(.c, .d), [title="x,y"], .e'), ['.a', '.b:is(.c, .d)', '[title="x,y"]', '.e'],
  'selector lists split on top-level commas only');
assert.deepEqual(selectorRequirements('#dock-right .lil-gui.lil-root'), [['#dock-right', '.lil-gui', '.lil-root']]);
assert.deepEqual(selectorRequirements('body:not(.lil-dragging) .lil-gui .lil-title'), [['.lil-gui', '.lil-title']],
  'a negated class is never required — the clone does not carry lil-dragging, and the rule must survive');
assert.equal(selectorRequirements('button, .sp-seg'), null, 'an alternative with no class or id can match anything');
assert.equal(selectorRequirements(':root'), null, ':root carries the custom properties and is always kept');
assert.deepEqual(selectorRequirements('.a[data-x=".b"]::before'), [['.a']],
  'attribute values and pseudo-elements add no requirement');
assert.deepEqual(selectorRequirements('.lil-controller:has(.lil-slider) .x, .y'), [['.lil-controller', '.x'], ['.y']],
  'relational arguments are optional; each alternative keeps its own requirement');
assert.deepEqual(selectorRequirements('.ll-row:nth-child(2 of .ll-row)'), [['.ll-row']]);
const present = new Set(['.lil-gui', '.lil-title', '#dock-right']);
assert(ruleMayApply(null, present), 'an unconditional rule always applies');
assert(ruleMayApply([['.lil-gui', '.lil-title']], present));
assert(!ruleMayApply([['.sp-modal']], present), 'a modal rule is dropped from a toolbox image');
assert(ruleMayApply([['.sp-modal'], ['#dock-right']], present), 'one matching alternative keeps the rule');

// ---- page geometry
assert.deepEqual(unionRect(null, { x: 1, y: 2, width: 3, height: 4 }), { x: 1, y: 2, width: 3, height: 4 });
assert.deepEqual(unionRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: -5, width: 10, height: 5 }),
  { x: 0, y: -5, width: 15, height: 15 });
assert.deepEqual(intersectRect({ x: 0, y: 0, width: 300, height: 900 }, { x: 0, y: 46, width: 300, height: 720 }),
  { x: 0, y: 46, width: 300, height: 720 }, 'a toolbox taller than its clamped dock is cut to the dock');
assert.equal(intersectRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 }), null,
  'rects that only touch share nothing');
assert.deepEqual(paddedPixelRect({ x: 10.4, y: 20.6, width: 100.2, height: 30 }, 4, 1000, 800),
  { x: 6, y: 16, width: 109, height: 39 }, 'padding grows the part, then snaps outward to whole pixels');
assert.deepEqual(paddedPixelRect({ x: -10, y: 790, width: 50, height: 30 }, 0, 1000, 800),
  { x: 0, y: 790, width: 40, height: 10 }, 'a part is clipped to the window it is laid out in');
assert.equal(paddedPixelRect({ x: 1200, y: 10, width: 50, height: 30 }, 4, 1000, 800), null,
  'a part entirely off the window has nothing to draw');

const region = { x: 100, y: 50, width: 400, height: 200 };
assert.deepEqual(mirrorUvToClient(region, 0, 1), { x: 100, y: 50 }, 'UV (0, 1) is the image top-left (three flips Y)');
assert.deepEqual(mirrorUvToClient(region, 1, 0), { x: 500, y: 250 });
const part = { x: 300, y: 100, width: 100, height: 50 };
const [u0, v0, u1, v1] = partUvRect(region, part);
assert.deepEqual([u0, v0, u1, v1], [0.5, 0.5, 0.75, 0.75], 'a part occupies its own window of the shared texture');
assert.deepEqual(mirrorUvToClient(region, u0, v1), { x: 300, y: 100 }, "a part's top-left UV is its top-left on the page");
assert.deepEqual(mirrorUvToClient(region, u1, v0), { x: 400, y: 150 }, "and its bottom-right UV its bottom-right");

// ---- dropdown stepping (the stand-in for a popup a headset never sees)
assert.equal(nextSelectableIndex([false, true, false], 0, 1), 2, 'a disabled option is stepped over');
assert.equal(nextSelectableIndex([false, false, false], 2, 1), 0, 'stepping wraps');
assert.equal(nextSelectableIndex([false, false, true], 0, -1), 1, 'backwards also wraps and skips');
assert.equal(nextSelectableIndex([true, false, true], 1, 1), 1, 'with nothing else selectable it stays put');

// ---- palette layout: around the watch, in its plane
{
  const close = (a: number, b: number, what: string) => assert(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);
  const gap = 0.01, watch = { w: 0.18, h: 0.17 };
  const stack = [{ w: 0.44, h: 0.03 }, { w: 0.3, h: 0.02 }, null, { w: 0.4, h: 0.02 }];
  const tools = { w: 0.24, h: 0.6 }, legend = { w: 0.1, h: 0.2 };
  const laid = layoutAroundWatch({ stack, tools, legend, docked: [{ w: 0.38, h: 0.3 }, null, { w: 0.03, h: 0.1 }] },
    watch, gap);
  close(laid.tools!.x + laid.tools!.w / 2, -gap, "the toolbox's right edge is a gap left of the watch");
  close(laid.tools!.y + laid.tools!.h / 2, 0, 'and its top is level with the watch top');
  close(laid.stack[3]!.y - laid.stack[3]!.h / 2, gap, 'the lowest menu strip sits a gap above the watch and toolbox');
  close(laid.stack[1]!.y - laid.stack[1]!.h / 2, gap + 0.02, 'the strips touch, and a missing one takes no space');
  close(laid.stack[0]!.y - laid.stack[0]!.h / 2, laid.stack[1]!.y + laid.stack[1]!.h / 2, 'one bar, no gaps');
  assert.equal(laid.stack[2], null);
  close(laid.stack[0]!.y + laid.stack[0]!.h / 2, laid.top, 'the status strip is the top row');
  for (const row of [laid.stack[0], laid.stack[1], laid.stack[3]]) {
    close(row!.x - row!.w / 2, laid.left, 'the strips are left-aligned with the toolbox');
  }
  close(laid.legend!.x - laid.legend!.w / 2, watch.w + gap, 'the keys stand right of the watch');
  close(laid.legend!.y + laid.legend!.h / 2, 0, 'top edges level');
  close(laid.docked[0]!.x - laid.docked[0]!.w / 2, 0, 'a library stands right of the toolbox');
  close(laid.docked[0]!.y - laid.docked[0]!.h / 2, -tools.h, "on the toolbox's bottom edge while that clears the watch");
  assert(laid.docked[0]!.y + laid.docked[0]!.h / 2 <= -legend.h - gap + 1e-12, 'and it clears the keys too');
  assert.equal(laid.docked[1], null, 'a closed library takes no space');
  close(laid.docked[2]!.x - laid.docked[2]!.w / 2, 0.38 + gap, 'a tab stands beside the open library');
  close(laid.right, 0.38 + gap + 0.03, 'the docked run is the widest thing here');
  close(laid.bottom, -tools.h, 'the extent includes the toolbox bottom');

  // A mode switch: a shorter toolbox, the keys gone. Nothing above or beside the watch may move — the first
  // headset pass saw the whole palette shift with each mode's toolbox height.
  const short = layoutAroundWatch({ stack, tools: { w: 0.24, h: 0.2 }, legend: null, docked: [{ w: 0.38, h: 0.3 }] },
    watch, gap);
  assert.deepEqual(short.stack, laid.stack, 'the menu strips stay put across modes');
  close(short.tools!.y + short.tools!.h / 2, 0, 'the toolbox top stays level with the watch top');
  close(short.docked[0]!.y + short.docked[0]!.h / 2, -watch.h - gap,
    'a toolbox too short for the library drops it below the watch instead of beside it');
  const bare = layoutAroundWatch({ stack: [], tools: null, legend: null, docked: [] }, watch, gap);
  assert.deepEqual([bare.left, bare.right, bare.top, bare.bottom], [0, watch.w, 0, -watch.h],
    'with nothing to show the extent is the watch');
}
{
  // The default seat is the watch's top-left corner as worn, so the layout's origin lands exactly there.
  const watchNode = new THREE.Object3D();
  watchNode.position.set(...XR_WATCH_POSITION);
  watchNode.rotation.set(XR_WATCH_TILT, 0, 0);
  watchNode.updateMatrixWorld(true);
  const corner = new THREE.Vector3(-XR_WATCH_WIDTH / 2, XR_WATCH_HEIGHT / 2, 0).applyMatrix4(watchNode.matrixWorld);
  const seat = XR_EDIT_PALETTE_SEAT;
  assert(corner.distanceTo(new THREE.Vector3(seat.x, seat.y, seat.z)) < 1e-9, 'the palette seat is the watch corner');
  assert.equal(seat.tilt, XR_WATCH_TILT, "and the palette lies in the watch's plane");
}

// ---- the placement bar over the palette
{
  const seat0 = { ...XR_EDIT_PALETTE_SEAT };
  const tenthMm = (value: number) => Math.round(value * 1e4) / 1e4;
  let seat = seat0;
  for (let i = 0; i < 7; i++) seat = stepPaletteSeat(seat, 'in', seat0);
  assert.equal(seat.z, tenthMm(seat0.z + 0.07), 'IN is grip +Z, and a run of 1 cm steps reads back as a round number');
  seat = stepPaletteSeat(stepPaletteSeat(seat, 'left', seat0), 'up', seat0);
  assert.deepEqual([seat.x, seat.y], [tenthMm(seat0.x - 0.01), tenthMm(seat0.y + 0.01)], 'LEFT is grip −X, UP grip +Y');
  seat = stepPaletteSeat(seat, 'tilt-in', seat0);
  assert(seat.tilt > seat0.tilt, 'TILT IN brings the top edge toward the eyes (less lean)');
  for (let i = 0; i < 200; i++) seat = stepPaletteSeat(seat, 'smaller', seat0);
  assert(seat.scale >= 0.25 && seat.scale < 0.26, 'size bottoms out instead of vanishing');
  assert(!samePaletteSeat(seat, seat0));
  assert.deepEqual(stepPaletteSeat(seat, 'reset', seat0), seat0, 'RESET returns to the defaults');

  const buttons = XR_PALETTE_SEAT_BUTTONS;
  assert.equal(buttons.length, 11);
  for (let i = 1; i < buttons.length; i++) {
    assert(buttons[i].x >= buttons[i - 1].x + buttons[i - 1].w, `${buttons[i].action} starts clear of its neighbour`);
  }
  const last = buttons[buttons.length - 1];
  assert(last.x + last.w <= 1280 - 11, 'the row fits the bar');
  // Canvas pixels to three's UV (v runs up) on a 1280 × 176 bar.
  const uvOf = (x: number, y: number): [number, number] => [x / 1280, 1 - y / 176];
  for (const b of buttons) {
    assert.equal(paletteSeatActionAt(...uvOf(b.x + b.w / 2, b.y + b.h / 2)), b.action, `${b.label} is hit at its centre`);
  }
  const out = buttons.find(b => b.action === 'out')!, left = buttons.find(b => b.action === 'left')!;
  assert.equal(paletteSeatActionAt(...uvOf((out.x + out.w + left.x) / 2, out.y + out.h / 2)), null,
    'the gap between groups is no button');
  assert.equal(paletteSeatActionAt(...uvOf(out.x + out.w / 2, 140)), null, 'the readout is no button');
}

// ---- the palette's crop keys are still the panels' own
{
  assert.deepEqual(XR_EDIT_MIRRORS.map(m => m.rootId), ['dock-top', 'dock-right', 'lowerleft',
    'texture-library', 'prop-library', 'texture-library-tab', 'prop-library-tab']);
  const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  // The libraries and their pull-up tabs are made in script, not in index.html.
  const madeInScript: Record<string, string> = {
    'texture-library': '../src/app/paint/library.ts', 'prop-library': '../src/app/props/library.ts',
    'texture-library-tab': '../src/app/main.ts', 'prop-library-tab': '../src/app/main.ts',
  };
  for (const { rootId } of XR_EDIT_MIRRORS) {
    const source = madeInScript[rootId];
    if (!source) { assert(index.includes(`id="${rootId}"`), `index.html still has #${rootId}`); continue; }
    assert(readFileSync(new URL(source, import.meta.url), 'utf8').includes(`'${rootId}'`),
      `${source} still gives its panel the id #${rootId} — otherwise the palette silently never shows it`);
  }
  const topBar = readFileSync(new URL('../src/app/ui/chrome/top-bar.ts', import.meta.url), 'utf8');
  const legends = readFileSync(new URL('../src/app/viewport/shared/legends.ts', import.meta.url), 'utf8');
  for (const key of XR_EDIT_MIRRORS.flatMap(m => m.parts ?? [])) {
    const carried = topBar.includes(`xrEdit('${key}'`) || legends.includes(`dataset.xrEdit = '${key}'`);
    assert(carried, `some panel still carries data-xr-edit="${key}" — otherwise that palette strip is silently empty`);
  }
  const dock = readFileSync(new URL('../src/app/styles/dock.css', import.meta.url), 'utf8');
  assert(dock.includes('body.os-xr-editing #dock-right'), 'the toolbox clamp the palette relies on still exists');
  assert(dock.includes('body.os-xr-editing .sp-pal') && dock.includes('body.os-xr-editing .pl-pal'),
    'the libraries narrow while the palette shows them: full window width would be metres wide on the wrist');
}

console.log('xr-dom-mirror: ok');
