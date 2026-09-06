// tier: fast

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { blankMountain, migrateMountain } from '../src/core/doc/mountain';
import { buildLevelFiles } from '../src/core/export/level';
import { applyRegisters, documentRegisters, objectRegister } from '../src/core/doc/registers';
import { decodeBillboards } from '../src/core/reference/screens';
import type { ReferenceScreenPickDetails } from '../src/core/reference/screens';
import {
  fitScreenToMeshes, screenPose, screenPoseFromAxes, screenProp, SCREEN_PROUD,
} from '../src/core/props/screen';
import { screenPresentation } from '../src/app/viewport/scene/screen-presentation';
import { createScreenTestPatternTexture } from '../src/app/viewport/scene/screen-test-pattern';
import { createScreensLayer } from '../src/app/viewport/scene/screens';
import type { PlacedProp, Screen } from '../src/core/doc/types';
import { check, failures, near } from './check';

/**
 * Video screens (docs/051): the rectangle a runtime lays video over, authored here and exported as the same
 * `Billboards.json` `snowknife billboards` measures off an extracted course.
 *
 * Three things have to hold for the feature to be worth having. A screen ATTACHED to a board has to ride that
 * board through every ordinary edit — otherwise marking a billboard is a thing you do once and then keep
 * fixing. The FIT has to land on the ad face rather than the structure behind it, which is the same
 * texture-led judgement the detector makes over a whole course. And the EXPORT has to put the rectangle in
 * mesh space exactly where the editor drew it, because that file is the whole contract with every consumer.
 */
const sameV = (a: readonly number[], b: readonly number[], eps = 1e-6) =>
  a.every((v, i) => Math.abs(v - b[i]) <= eps);

const videoBillboardSource = readFileSync(
  resolve(process.cwd(), 'src/app/viewport/scene/video-billboard.ts'),
  'utf8',
);
check(
  /new THREE\.VideoTexture\(video\)/.test(videoBillboardSource)
    && /showingVideo[\s\S]*?movieTexture\.needsUpdate = true;/.test(videoBillboardSource),
  'playback: movie pixels use VideoTexture with a per-viewport-frame Quest fallback',
);
check(
  !/three-html-render|layoutsubtree|texElementImage2D|requestPaint/.test(videoBillboardSource)
    && /const decoderHost = element\('div'/.test(videoBillboardSource),
  'playback: video needs no HTML-in-Canvas API or browser flag',
);
check(
  /startYouTubeFallback/.test(videoBillboardSource)
    && /An iframe cannot be uploaded into WebGL[\s\S]*?showVideoSurface\(false\)/.test(videoBillboardSource),
  'playback: the YouTube fallback stays in the DOM and never publishes a course-screen texture',
);
check(
  /decoderHost\.appendChild\(root\)/.test(videoBillboardSource)
    && /Project the permanent media subtree/.test(videoBillboardSource)
    && !/root\.remove\(\)|host\.appendChild\(root\)/.test(videoBillboardSource),
  'playback: mode changes reposition one page-stable player without reparenting its iframe',
);

const board = (over: Partial<PlacedProp> = {}): PlacedProp => ({
  id: 'prop:0000', level: 'GARI', model: 3, name: 'Mdl_Billboard_Ad_A',
  pos: [10, 5, -20], yaw: 0, scale: 1, ...over,
});

// ---- playback and Sources are independent visibility gates -----------------------------------------------
{
  const hidden = screenPresentation(false, false);
  check(!hidden.layerVisible && !hidden.panelVisible && !hidden.inspectionVisible && !hidden.pickable,
    'presentation: idle screens disappear when Sources is off');

  const authoring = screenPresentation(true, false);
  check(authoring.layerVisible && authoring.panelVisible && authoring.inspectionVisible && authoring.pickable,
    'presentation: Sources reveals idle panels, icons, borders and pick targets');

  const playback = screenPresentation(false, true);
  check(playback.layerVisible && playback.panelVisible && !playback.inspectionVisible && !playback.pickable,
    'presentation: playback shows only video panels when Sources is off');

  const inspectedPlayback = screenPresentation(true, true);
  check(inspectedPlayback.layerVisible && inspectedPlayback.panelVisible
    && inspectedPlayback.inspectionVisible && inspectedPlayback.pickable,
    'presentation: Sources overlays selectable rigging on active video');
}

// ---- Sources gives every screen an opaque colour-bar coverage card; selection remains independent -------
{
  const pattern = createScreenTestPatternTexture();
  const pixels = pattern.image.data as Uint8Array;
  const topBars = new Set(Array.from({ length: 7 }, (_, index) => {
    const offset = ((32 - 1) * 56 + index * 8) * 4;
    return `${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}`;
  }));
  check(topBars.size === 7
    && sameV(Array.from(pixels.slice(0, 3)), [0, 33, 76])
    && pixels.every((value, index) => index % 4 !== 3 || value === 255),
    'coverage card: seven classic colour bars, upright bottom row and every pixel is opaque');
  pattern.dispose();

  const picks: { level: string | null; screen: ReferenceScreenPickDetails | null }[] = [];
  const stage: any = {
    worldRoot: new THREE.Group(), refRoot: new THREE.Group(), scene: new THREE.Scene(),
    cb: { onSelectReferenceScreen: (level: string | null, screen: ReferenceScreenPickDetails | null) => {
      picks.push({ level, screen });
    } },
    gizmoKind: null,
    attachGizmo() {}, detachGizmo() {},
    worldPerPixel: () => 0.1,
  };
  const layer = createScreensLayer(stage);
  layer.setVisible(true);
  layer.setReference([{
    level: 'MERQUER', name: 'Ad_I_1000', family: 'Ad_I', instance: 730, page: '0030',
    width: 23.253438, height: 19.395518,
    pose: screenPoseFromAxes([1, 2, 3], [0, 0, 1], [0, 1, 0], 23.253438, 19.395518),
  }]);
  const panels: THREE.Mesh[] = [];
  layer.referenceGroup.traverse(object => {
    if (object instanceof THREE.Mesh && object.userData.screenPanel === true) panels.push(object);
  });
  const panel = panels[0];
  const coverageMaterial = panel?.material as THREE.MeshBasicMaterial | undefined;
  check(coverageMaterial?.map?.name === 'Screen coverage colour bars'
    && coverageMaterial.transparent === false && coverageMaterial.opacity === 1 && coverageMaterial.depthWrite
    && coverageMaterial.polygonOffset && coverageMaterial.polygonOffsetFactor === -1
    && coverageMaterial.polygonOffsetUnits === -1,
    'Sources: every panel is an opaque, depth-biased colour-bar coverage card');

  layer.seatReferenceScreen(0);
  check(panel?.material === coverageMaterial,
    'reference selection: clicking the icon keeps the coverage card and changes only selection decoration');
  const picked = picks[0];
  check(picked?.level === 'MERQUER' && picked.screen?.name === 'Ad_I_1000'
    && picked.screen.family === 'Ad_I' && picked.screen.instance === 730 && picked.screen.page === '0030',
    'reference selection: the inspector callback retains screen, family, native instance and texture page');

  const movie = new THREE.Texture();
  layer.setVideoTexture(movie);
  check(panel?.material === coverageMaterial,
    'Sources: the inspection card remains visible even while live video is available');
  layer.setVisible(false);
  const playbackMaterial = panel?.material as THREE.MeshBasicMaterial | undefined;
  check(playbackMaterial?.map === movie && playbackMaterial.polygonOffset
    && playbackMaterial.polygonOffsetFactor === -1 && playbackMaterial.polygonOffsetUnits === -1,
    'playback: Sources off returns the panel to the shared, depth-biased live-video texture');
}

// ---- an attached screen rides its board -------------------------------------------------------------------
{
  const screen: Screen = { id: 'screen:0000', prop: 'prop:0000', pos: [0, 4, 1], yaw: 0, width: 8, height: 4 };

  const upright = screenPose(screen, board());
  check(sameV(upright.center, [10, 9, -19]), 'attached: the stored pose is the board’s frame, offset by it');
  check(sameV(upright.normal, [0, 0, 1]), 'attached: an untilted screen at yaw 0 faces +Z');
  check(sameV(upright.up, [0, 1, 0]), 'attached: image-up is world up');
  check(sameV(upright.right, [1, 0, 0]), 'attached: right = up × normal');

  // Turn the board a quarter turn: the screen turns with it, about the board rather than about itself.
  const turned = screenPose(screen, board({ yaw: 90 }));
  check(sameV(turned.normal, [1, 0, 0], 1e-9), 'turned board: the screen faces where the board now faces');
  check(sameV(turned.center, [11, 9, -20], 1e-9), 'turned board: the screen swings around the board’s pivot');

  // Resize it: a screen is part of the board, so it scales with the geometry it covers.
  const bigger = screenPose(screen, board({ scale: 2 }));
  check(near(bigger.width, 16) && near(bigger.height, 8), 'resized board: the screen scales with it');
  check(sameV(bigger.center, [10, 13, -18]), 'resized board: its offset scales too');

  // A free-standing screen is world space and answers for itself.
  const free = screenPose({ id: 'screen:0001', pos: [1, 2, 3], yaw: 180, width: 6, height: 3 });
  check(sameV(free.center, [1, 2, 3]), 'free: the stored centre is the world centre');
  check(sameV(free.normal, [0, 0, -1], 1e-9), 'free: yaw 180 turns it around');

  check(screenProp(screen, [board()])?.id === 'prop:0000', 'a screen resolves the board it names');
  check(screenProp({ id: 'screen:0002', pos: [0, 0, 0], yaw: 0, width: 1, height: 1 }, [board()]) === undefined,
    'a free screen names no board');
}

// ---- the fit lands on the ad face, not the structure behind it --------------------------------------------
{
  // A 8 × 4 m ad panel at z = 0 showing its page once, and a smaller tiled structural slab 1 m behind it.
  const quad = (z: number, halfW: number, halfH: number, uvSpan: number) => ({
    positions: new Float32Array([
      -halfW, 1, z, halfW, 1, z, halfW, 1 + halfH * 2, z,
      -halfW, 1, z, halfW, 1 + halfH * 2, z, -halfW, 1 + halfH * 2, z,
    ]),
    uvs: new Float32Array([0, 0, uvSpan, 0, uvSpan, uvSpan, 0, 0, uvSpan, uvSpan, 0, uvSpan]),
  });
  const meshes = [quad(0, 4, 2, 1), quad(1, 2, 1, 4)];

  const fit = fitScreenToMeshes(meshes, [0, 3, -50]);   // viewed from in front (-Z)
  check(!!fit, 'fit: a flat near-vertical face is a screen');
  check(fit && near(fit.width, 8) && near(fit.height, 4), 'fit: sized to the AD face, not the tiled slab');
  check(fit && near(fit.pos[1], 3), 'fit: centred on the ad face');
  check(fit && near(fit.pos[2], -SCREEN_PROUD), 'fit: sat proud of the face, on the viewer’s side');
  check(fit && (near(fit.yaw, 180) || near(fit.yaw, -180)), 'fit: turned to face the viewer');

  // Seen from the other side, the same face is fitted the other way round — the winding is a coin-flip and
  // the viewpoint is what breaks it.
  const behind = fitScreenToMeshes(meshes, [0, 3, 50]);
  check(behind && near(behind.pos[2], SCREEN_PROUD) && near(behind.yaw, 0), 'fit: the viewpoint picks the side');

  // A model with nothing but ground gives no screen rather than a flat one lying in the snow.
  const floor = {
    positions: new Float32Array([-4, 0, -4, 4, 0, -4, 4, 0, 4, -4, 0, -4, 4, 0, 4, -4, 0, 4]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]),
  };
  check(fitScreenToMeshes([floor]) === null, 'fit: a horizontal face is not a screen');
}

// ---- the export writes the contract ------------------------------------------------------------------------
{
  const doc = migrateMountain(blankMountain());
  doc.props = [board({ pos: [0, 0, 0], yaw: 0 })];
  doc.screens = [
    { id: 'screen:0000', name: 'Jumbotron', prop: 'prop:0000', pos: [0, 6, 2], yaw: 0, width: 10, height: 5 },
    { id: 'screen:0001', pos: [3, 2, 1], yaw: 90, width: 4, height: 2 },
  ];

  const files = buildLevelFiles(doc);
  const written = files.text['Billboards.json'];
  check(!!written, 'export: a mountain with screens writes Billboards.json');
  const parsed = JSON.parse(written ?? '{}') as {
    Schema?: string; Source?: string; Screens?: Record<string, unknown>[];
  };
  check(parsed.Schema === 'openslope-billboards/v1', 'export: the document declares its contract');
  check(parsed.Source === 'authored',
    'export: authored, so a later detector run over the folder leaves these screens alone');
  check(parsed.Screens?.length === 2, 'export: one record per screen');

  const first = parsed.Screens?.[0] ?? {};
  check(first.Name === 'Jumbotron', 'export: the author’s name is the record name');
  check(first.Family === 'Mdl_Billboard_Ad_A', 'export: an attached screen is grouped by its board');
  // Editor (0, 6, 2) m -> mesh (0, -200, 600) cm: x·100, -z·100, y·100.
  check(sameV(first.Center as number[], [0, -200, 600], 1e-3), 'export: the centre is mesh-space centimetres');
  check(sameV(first.Normal as number[], [0, -1, 0], 1e-6), 'export: +Z in the editor is -Y in mesh space');
  check(sameV(first.Up as number[], [0, 0, 1], 1e-6), 'export: image-up is mesh +Z');
  check(first.Width === 1000 && first.Height === 500, 'export: sizes are centimetres');

  // The same numbers read back as the reference layer reads a shipped course's own file.
  const decoded = decodeBillboards(parsed);
  check(decoded.length === 2, 'reference: every record decodes');
  check(sameV(decoded[0].center, [0, 6, 2], 1e-6), 'reference: mesh space maps back to the editor point');
  check(sameV(decoded[0].normal, [0, 0, 1], 1e-6), 'reference: and so does the facing');
  check(near(decoded[0].width, 10), 'reference: sizes come back in metres');
  const detected = decodeBillboards({ Screens: [{
    Name: 'Ad_I_1000', Family: 'Ad_I', Instance: 730, Page: '0030',
    Center: [0, 0, 0], Normal: [0, -1, 0], Up: [0, 0, 1], Width: 2325.3438, Height: 1939.5518,
  }] })[0];
  check(detected?.name === 'Ad_I_1000' && detected.family === 'Ad_I'
    && detected.instance === 730 && detected.page === '0030',
    'reference: detected billboard identity survives decoding for selection details');
  check(decodeBillboards({ Screens: [{ Name: 'broken' }] }).length === 0,
    'reference: a malformed record is dropped, not thrown');

  // A mountain with no screens writes no file at all — the folder only grows where something was authored.
  const bare = migrateMountain(blankMountain());
  check(!buildLevelFiles(bare).text['Billboards.json'], 'export: no screens, no document');
}

// ---- a screen is a register ---------------------------------------------------------------------------------
{
  const doc = migrateMountain(blankMountain());
  doc.screens = [{ id: 'screen:0000', pos: [1, 2, 3], yaw: 45, width: 5, height: 3 }];
  const key = objectRegister('screen', 'screen:0000');
  check(documentRegisters(doc).has(key), 'registers: a screen is addressable by its own id');

  const other = migrateMountain(blankMountain());
  other.screens = [];
  applyRegisters(other, [[key, doc.screens[0]]]);
  check(other.screens?.length === 1 && other.screens[0].width === 5,
    'registers: assigning one lands it on a document that had none');
  applyRegisters(other, [[key, undefined]]);
  check(other.screens?.length === 0, 'registers: assigning nothing deletes it');
}

// ---- a screen survives a save / load round trip --------------------------------------------------------------
{
  const doc = migrateMountain(blankMountain());
  doc.screens = [{ pos: [0, 1, 2], yaw: 0, width: 4, height: 2 } as Screen];
  const reloaded = migrateMountain(JSON.parse(JSON.stringify(doc)) as unknown);
  check(reloaded.screens?.length === 1, 'migrate: screens survive a round trip');
  check(!!reloaded.screens?.[0].id, 'migrate: a screen saved without an id is named on load');
}

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('video-screens: all checks passed');
