// tier: fast

import { blankMountain, migrateMountain } from '../src/core/doc/mountain';
import { applyRegisters, documentRegisters, objectRegister } from '../src/core/doc/registers';
import type { PlacedProp, PropLine, V3 } from '../src/core/doc/types';
import {
  footprintOfRawBox, groupFootprint, layoutPropLine, lineMemberId, lineMembers, lineModelLength, lineNominalSpacing,
  LINE_MAX_MEMBERS, nextPropLineId, replaceLineMembers, type LineFootprint, type LineGround, type LinePose,
} from '../src/core/props/prop-line';
import { rotateByPlacement } from '../src/core/props/pose';
import { check, checkNear, failures, near } from './check';

/**
 * Prop lines (docs/070): a path that owns a row of placements. The layout is the whole of the feature's
 * geometry, and every claim it makes is one a viewport would only show as "looks about right" — panels that
 * nearly meet, a fence that nearly follows the ground — so they are pinned here as numbers instead.
 */

/** A 4 m × 0.2 m fence panel, origin at its base centre: the shape the defaults are designed around. */
const PANEL: LineFootprint = { minX: -2, maxX: 2, minZ: -0.1, maxZ: 0.1, minY: 0 };
const flat: LineGround = () => 0;
const line = (nodes: V3[], extra: Partial<PropLine> = {}): PropLine & { id: string } => ({
  id: 'line:0000', nodes, scale: 1, template: { level: 'GARI', model: 7, name: 'Mdl_Fence' }, ...extra,
});
/** A member's two ends along its own long (X) axis, in world space, at the size it was laid out at. */
const ends = (pose: LinePose, f = PANEL): [V3, V3] => {
  const at = (x: number): V3 => {
    const [ox, oy, oz] = rotateByPlacement([x * pose.scale, 0, 0], pose);
    return [pose.pos[0] + ox, pose.pos[1] + oy, pose.pos[2] + oz];
  };
  return [at(f.minX), at(f.maxX)];
};
const plan = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[2] - b[2]);

// ---- the footprint: raw model space (cm, Z-up, X mirrored) read as the editor sees it -----------------------
{
  const f = footprintOfRawBox({ min: [-100, -20, 5], max: [300, 20, 150] });
  check(near(f.minX, -3) && near(f.maxX, 1) && near(f.minZ, -0.2) && near(f.maxZ, 0.2) && near(f.minY, 0.05),
    'footprint: raw X is mirrored, raw Y becomes editor Z, raw Z is height', JSON.stringify(f));
  const group = groupFootprint([
    { footprint: PANEL, relPos: [0, 0, 0], relYaw: 0 },
    { footprint: { minX: -0.1, maxX: 0.1, minZ: -0.1, maxZ: 0.1, minY: -0.5 }, relPos: [2, 0, 0], relYaw: 90 },
  ])!;
  check(near(group.minX, -2) && near(group.maxX, 2.1) && near(group.minY, -0.5),
    'footprint: a group boxes its members at their own offsets, seated on the lowest', JSON.stringify(group));
}

// ---- spacing: the model's own length along the line unless the line says otherwise --------------------------
{
  checkNear(lineNominalSpacing(line([]), PANEL), 4, 'spacing: a panel butts end to end by default');
  checkNear(lineNominalSpacing(line([], { scale: 1.5 }), PANEL), 6, 'spacing: follows the line scale');
  checkNear(lineModelLength({ turn: 90, scale: 1 }, PANEL), 0.2, 'spacing: a quarter turn puts the short side along');
  checkNear(lineNominalSpacing(line([], { spacing: 7 }), PANEL), 7, 'spacing: an explicit spacing wins');
}

// ---- a straight line on flat ground ---------------------------------------------------------------------------
{
  const poses = layoutPropLine(line([[0, 0, 0], [20, 0, 0]]), PANEL, flat);
  check(poses.length === 5, 'straight: 20 m of 4 m panels is five', `${poses.length}`);
  check(poses.every((pose, k) => near(pose.pos[0], 2 + 4 * k, 1e-6) && near(pose.pos[2], 0) && near(pose.pos[1], 0)),
    'straight: each panel is centred on its step', poses.map(p => p.pos[0].toFixed(3)).join(' '));
  check(poses.every(pose => near(pose.yaw % 180, 0, 1e-6) && !pose.pitch && !pose.roll),
    'straight: panels lie along the line, upright');
  const fitted = layoutPropLine(line([[0, 0, 0], [21, 0, 0]]), PANEL, flat);
  check(fitted.length === 5 && near(fitted[4].pos[0], 21 - 2.1, 1e-4),
    'fit: 21 m still takes five panels, the step stretched so the last ends on the last node',
    fitted.map(p => p.pos[0].toFixed(3)).join(' '));
  check(fitted.every(p => near(p.scale, 1.05, 1e-4)), 'fit: butted panels grow with the step, so they still meet',
    fitted[0].scale.toFixed(4));
  const spaced = layoutPropLine(line([[0, 0, 0], [21, 0, 0]], { spacing: 4 }), PANEL, flat);
  check(spaced.length === 5 && spaced.every(p => p.scale === 1), 'fit: an explicit spacing moves only the gaps');
  const southward = layoutPropLine(line([[0, 0, 0], [0, 0, -12]]), PANEL, flat);
  const [a, b] = ends(southward[0]);
  check(near(plan(a, [0, 0, 0]) + plan(b, [0, 0, -4]), 0, 1e-6) || near(plan(b, [0, 0, 0]) + plan(a, [0, 0, -4]), 0, 1e-6),
    'direction: a line running −Z turns the panel to span it', JSON.stringify([a, b]));
}

// ---- a curve: straight steps, so every panel meets the next on the curve ------------------------------------
{
  const nodes: V3[] = [[0, 0, 0], [15, 0, 5], [25, 0, 20], [28, 0, 40]];
  const poses = layoutPropLine(line(nodes), PANEL, flat);
  let worst = 0;
  for (let k = 0; k < poses.length - 1; k++) worst = Math.max(worst, plan(ends(poses[k])[1], ends(poses[k + 1])[0]));
  check(worst < 1e-4, 'curve: each panel ends exactly where the next begins', `worst gap ${worst.toExponential(2)} m`);
  check(plan(ends(poses[0])[0], nodes[0]) < 1e-6 && plan(ends(poses[poses.length - 1])[1], nodes[nodes.length - 1]) < 1e-4,
    'curve: the run starts on the first node and ends on the last');
  check(poses.every(pose => pose.scale === poses[0].scale), 'curve: one step length, so one size, along the whole line');
}

// ---- the ground: upright panels sit on the lowest ground under them; raked ones follow it ---------------------
{
  const slope: LineGround = x => x * 0.5;
  const upright = layoutPropLine(line([[0, 0, 0], [8, 4, 0]]), PANEL, slope);
  check(upright.length === 2 && near(upright[0].pos[1], 0, 1e-6) && near(upright[1].pos[1], 2, 1e-6),
    'upright: each panel seats on the lower end of its step, so nothing floats',
    upright.map(p => p.pos[1].toFixed(3)).join(' '));
  const raked = layoutPropLine(line([[0, 0, 0], [8, 4, 0]], { rake: true }), PANEL, slope);
  const dir = rotateByPlacement([1, 0, 0], raked[0]);
  check(raked.length === 2 && near(dir[1] / dir[0], 0.5, 1e-6),
    'rake: the panel tilts to the slope of its step', JSON.stringify(dir));
  const [low, high] = ends(raked[0]);
  check(near(low[1], slope(low[0], low[2], 0)!, 1e-4) && near(high[1], slope(high[0], high[2], 0)!, 1e-4),
    'rake: both ends of the panel rest on the ground', JSON.stringify([low, high]));
  const offset: LineFootprint = { ...PANEL, minY: -0.4 };
  const buried = layoutPropLine(line([[0, 0, 0], [8, 0, 0]]), offset, flat);
  checkNear(buried[0].pos[1], 0.4, 'seat: a model whose base sits below its origin is lifted onto the ground');
}

// ---- joints: one member standing at every joint, both ends included --------------------------------------------
{
  const lamp: LineFootprint = { minX: -0.2, maxX: 0.2, minZ: -0.2, maxZ: 0.2, minY: 0 };
  const poses = layoutPropLine(line([[0, 0, 0], [20, 0, 0]], { place: 'joint', spacing: 5 }), lamp, flat);
  check(poses.length === 5 && poses.every((pose, k) => near(pose.pos[0], 5 * k, 1e-6)),
    'joint: a lamp every 5 m from end to end', poses.map(p => p.pos[0].toFixed(2)).join(' '));
  const turned = layoutPropLine(line([[0, 0, 0], [20, 0, 0]], { place: 'joint', spacing: 5, turn: 90 }), lamp, flat);
  check(turned.every(pose => near(((pose.yaw - poses[0].yaw) % 360 + 360) % 360, 90, 1e-6)),
    'turn: the line turn adds to every member');
}

// ---- degenerate lines lay out nothing, and a runaway one stops at the member limit -----------------------------
{
  check(layoutPropLine(line([[0, 0, 0]]), PANEL, flat).length === 0, 'degenerate: one node is no line yet');
  check(layoutPropLine(line([[3, 0, 3], [3, 0, 3]]), PANEL, flat).length === 0, 'degenerate: two nodes on one spot');
  const long = layoutPropLine(line([[0, 0, 0], [5000, 0, 0]], { spacing: 0.01 }), PANEL, flat);
  check(long.length <= LINE_MAX_MEMBERS, 'limit: a line never lays out more than the member limit', `${long.length}`);
}

// ---- members: copies of the template, named by the line and their place in it ----------------------------------
{
  const l = line([[0, 0, 0], [8, 0, 0]], { template: { level: 'GARI', model: 7, name: 'Mdl_Fence', labels: ['label:0000'] } });
  const members = lineMembers(l, layoutPropLine(l, PANEL, flat));
  check(members.length === 2 && members[0].id === lineMemberId(l.id, 0) && members[1].id === 'line:0000:001',
    'members: ids come from the line and the member\'s place in it');
  check(members.every(m => m.line === l.id && m.level === 'GARI' && m.model === 7 && m.scale === 1),
    'members: each is a tagged copy of the template');
  check(!('pitch' in members[0]) && !('roll' in members[0]), 'members: an upright member stores no tilt');
  members[0].labels!.push('label:0001');
  check(l.template.labels!.length === 1 && members[1].labels!.length === 1, 'members: the template is copied, never shared');
}

// ---- replacing members touches only the line's own slots -------------------------------------------------------
{
  const prop = (id: string, extra: Partial<PlacedProp> = {}): PlacedProp =>
    ({ id, level: 'GARI', model: 1, name: id, pos: [0, 0, 0], yaw: 0, scale: 1, ...extra });
  const member = (i: number, x: number) => prop(lineMemberId('line:0000', i), { line: 'line:0000', pos: [x, 0, 0] });
  const props = [prop('prop:0000'), member(0, 0), member(1, 0), member(2, 0), prop('prop:0001')];
  const shrink = replaceLineMembers(props, 'line:0000', [member(0, 1), member(1, 1)]);
  check(props.map(p => p.id).join() === 'prop:0000,line:0000:000,line:0000:001,prop:0001'
    && props[1].pos[0] === 1 && shrink.removed.join() === 'line:0000:002' && !shrink.added.length,
  'replace: survivors keep their slots, the surplus is removed', props.map(p => p.id).join());
  const grow = replaceLineMembers(props, 'line:0000', [member(0, 2), member(1, 2), member(2, 2), member(3, 2)]);
  check(props.map(p => p.id).join() === 'prop:0000,line:0000:000,line:0000:001,line:0000:002,line:0000:003,prop:0001'
    && grow.added.join() === 'line:0000:002,line:0000:003',
  'replace: new members follow the line\'s last one, not the end of the list', props.map(p => p.id).join());
  replaceLineMembers(props, 'line:0000', []);
  check(props.map(p => p.id).join() === 'prop:0000,prop:0001', 'replace: an empty layout removes every member');
}

// ---- a line is a document object: an id, a register, and a round trip -------------------------------------------
{
  check(nextPropLineId([{ id: 'line:0000' } as PropLine]) === 'line:0001', 'identity: the next free line id');
  const raw = migrateMountain(blankMountain()) as unknown as Record<string, unknown>;
  raw.propLines = [line([[0, 0, 0], [8, 0, 0]], { id: undefined })];
  const doc = migrateMountain(JSON.parse(JSON.stringify(raw)));
  check(doc.propLines?.[0].id === 'line:0000', 'migrate: a line saved without an id is given one');
  const key = objectRegister('prop-line', 'line:0000');
  check(documentRegisters(doc).has(key), 'registers: a prop line is addressable by its own id');
  const other = migrateMountain(blankMountain());
  applyRegisters(other, [[key, doc.propLines![0]]]);
  check(other.propLines?.length === 1 && other.propLines[0].nodes.length === 2,
    'registers: assigning a line lands it on a document that had none');
  applyRegisters(other, [[key, undefined]]);
  check(other.propLines?.length === 0, 'registers: assigning nothing deletes it');
}

if (failures) process.exitCode = 1;
