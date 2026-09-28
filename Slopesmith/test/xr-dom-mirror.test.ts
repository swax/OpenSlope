// tier: fast

// The wrist EDIT palette's DOM mirror (docs/068), checked without a browser. The rasterizer itself needs a real
// one (`?xrpanels=1` shows it); what is pinned here is the geometry and bookkeeping around it, where a quiet
// mistake would put a click on the wrong control or drop the CSS a panel needs:
//  - the CSS filter keeps every rule that COULD match (negations and alternatives never make a class required);
//  - a texture UV maps back to the page point it was drawn from, per part;
//  - dropdown stepping skips disabled options and wraps;
//  - the palette layout stacks rows from the wrist up, left-aligned, and docks the libraries to the toolbox bottom;
//  - the `data-xr-edit` keys the palette crops to are still the ones the panels carry.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  intersectRect, mirrorUvToClient, nextSelectableIndex, paddedPixelRect, partUvRect, ruleMayApply, selectorRequirements,
  splitSelectorList, unionRect,
} from '../src/app/ride/xr/dom-mirror';
import { layoutPaletteRows, layoutWorkBlock, XR_EDIT_MIRRORS } from '../src/app/ride/xr/edit-palette';

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

// ---- palette layout
{
  const close = (a: number, b: number, what: string) => assert(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);
  const { placements, width, height } = layoutPaletteRows([
    [{ w: 0.2, h: 0.01 }],
    [{ w: 0.1, h: 0.02 }, null, { w: 0.05, h: 0.03 }],
    [],
    [{ w: 0.12, h: 0.3 }, { w: 0.1, h: 0.16 }],
  ], 0.01);
  close(width, 0.23, 'the widest row sets the width');
  close(height, 0.36, 'three used rows and two gaps; an empty row takes no space');
  close(placements[0][0]!.x, -0.015, 'rows start at one shared left edge');
  close(placements[0][0]!.y, 0.355, 'the first row is at the top');
  assert.equal(placements[1][1], null, 'a missing panel leaves no hole');
  close(placements[1][2]!.x, 0.02, 'a missing panel takes no width either');
  close(placements[1][2]!.y, 0.325, 'items top-align within their row');
  close(placements[3][0]!.y - placements[3][0]!.h / 2, 0, 'the origin is the bottom of the block: it grows up from the wrist');
  close(placements[3][1]!.x, 0.065, 'the legend sits right of the toolbox');
}
{
  const close = (a: number, b: number, what: string) => assert(Math.abs(a - b) < 1e-9, `${what}: ${a} vs ${b}`);
  const tools = { w: 0.24, h: 0.5 }, legend = { w: 0.1, h: 0.1 };
  const work = layoutWorkBlock(tools, legend, [{ w: 0.3, h: 0.2 }, null, { w: 0.03, h: 0.1 }], 0.01);
  close(work.width, 0.59, 'toolbox, gap, then the wider of the keys and the docked run');
  close(work.height, 0.5, 'a tall toolbox sets the height');
  close(work.tools!.y + work.tools!.h / 2, work.height / 2, 'the toolbox hangs from the block top');
  close(work.legend!.x - work.legend!.w / 2, work.tools!.x + work.tools!.w / 2 + 0.01, 'the keys sit right of the toolbox');
  close(work.legend!.y + work.legend!.h / 2, work.height / 2, 'the keys hang from the toolbox top edge');
  close(work.docked[0]!.x - work.docked[0]!.w / 2, work.legend!.x - work.legend!.w / 2,
    'the library docks straight right of the toolbox');
  close(work.docked[0]!.y - work.docked[0]!.h / 2, -work.height / 2, 'the library stands on the toolbox bottom edge');
  assert.equal(work.docked[1], null, 'a closed library takes no space');
  close(work.docked[2]!.x - work.docked[2]!.w / 2, work.docked[0]!.x + work.docked[0]!.w / 2 + 0.01,
    'a tab stands beside the open library');
  close(work.docked[2]!.y - work.docked[2]!.h / 2, -work.height / 2, 'and on the same bottom edge');

  const short = layoutWorkBlock({ w: 0.24, h: 0.2 }, legend, [{ w: 0.3, h: 0.2 }], 0.01);
  close(short.height, 0.31, 'a short toolbox grows the block so the library clears the keys');
  close((short.legend!.y - short.legend!.h / 2) - (short.docked[0]!.y + short.docked[0]!.h / 2), 0.01,
    'one gap between the keys and the library below them');
  const bare = layoutWorkBlock(tools, null, [null, null], 0.01);
  close(bare.width, 0.24, 'with nothing docked or keyed the block is just the toolbox');
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
