// tier: fast

/**
 * Surface-frame prop transforms (docs/012 · Surface frame, core/props/surface-follow.ts):
 *
 *  - a Move keeps each placement's vertical offset from the ground — sunk, seated or floating — over any slope,
 *    and a lone point (a gem, a rail point, a light) rides the same way;
 *  - where the mountain passes over itself, a placement keeps riding the deck it started on;
 *  - dragged off the surface's edge, a placement holds the height it last reached;
 *  - an authored group moves as one rigid unit, lifted by the mean change in the ground under its members;
 *  - a Scale pivots on the ground under each placement, spreading a set's spacing over the ground about the pivot;
 *  - a placement that stood over no surface moves and scales as a World transform would;
 *  - every frame is evaluated from the drag-start freeze, so repeating a frame lands in the same place.
 *
 * Run: tsx test/prop-surface-follow.test.ts
 */
import type { PlacedProp, V3 } from '../src/core/doc/types';
import {
  freezeSurfaceFollow, placementSurfaceItems, scaleOverSurface, slideOverSurface, type SurfaceHeight,
} from '../src/core/props/surface-follow';
import { check, failures } from './check';

const near = (a: readonly number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
const show = (v: readonly number[]) => `[${v.map(n => +n.toFixed(4)).join(', ')}]`;
const prop = (pos: V3, extra: Partial<PlacedProp> = {}): PlacedProp =>
  ({ level: 'GARI', model: 7, name: 'Mdl_Tree_1', pos, yaw: 0, scale: 1, ...extra });
const lookup = (props: PlacedProp[]) => (i: number) => props[i];

/** A plane falling half a metre per metre of +x, everywhere. */
const slope: SurfaceHeight = x => 0.5 * x;

// ---- Move keeps each placement's height over the ground
{
  const props = [prop([0, -0.3, 0]), prop([2, 3, 5]), prop([-2, -1, 1])]; // sunk 0.3, floating 2 above, seated
  const f = freezeSurfaceFollow(placementSurfaceItems(lookup(props), [0, 1, 2]), slope);
  const moved = slideOverSurface(f, 4, -1, slope);
  check(near(moved[0].pos, [4, 1.7, -1]), 'a sunk tree stays sunk as deep', show(moved[0].pos));
  check(near(moved[1].pos, [6, 5, 4]), 'a floating sign stays as high above the ground', show(moved[1].pos));
  check(near(moved[2].pos, [2, 1, 0]), 'a seated rock stays seated', show(moved[2].pos));
  const again = slideOverSurface(f, 4, -1, slope);
  check(again.every((u, i) => near(u.pos, moved[i].pos)), 'repeating a frame lands in the same place');
  const back = slideOverSurface(f, 0, 0, slope);
  check(back.every(u => near(u.pos, props[u.index].pos)), 'no travel is no change');
}

// ---- a Props-mode point — a gem, a rail point, a light — rides the same way
{
  const f = freezeSurfaceFollow([{ index: -1, pos: [0, 2, 0] }], slope); // a gem floating 2 m above
  const [gem] = slideOverSurface(f, -6, 1, slope);
  check(gem.index === -1 && near(gem.pos, [-6, -1, 1]), 'a floating gem keeps its float height', show(gem.pos));
}

// ---- a placement under a bridge keeps riding the deck it started on
{
  // ground at 0 everywhere; a deck at 10 over 2 <= x <= 6
  const decks: SurfaceHeight = (x, _z, nearY) => {
    const options = x >= 2 && x <= 6 ? [0, 10] : [0];
    return options.reduce((best, y) => Math.abs(y - nearY) < Math.abs(best - nearY) ? y : best);
  };
  const props = [prop([0, 0.5, 0]), prop([3, 10.2, 0])];
  const f = freezeSurfaceFollow(placementSurfaceItems(lookup(props), [0, 1]), decks);
  check(f.members[1].ground === 10, 'a prop on the bridge measures from the bridge');
  const under = slideOverSurface(f, 4, 0, decks);
  check(near(under[0].pos, [4, 0.5, 0]), 'slid under the bridge, it stays on the ground below', show(under[0].pos));
  check(near(under[1].pos, [7, 0.2, 0]), 'slid off the bridge\'s end, the other drops to the ground', show(under[1].pos));
}

// ---- off the edge of the surface, a placement holds the height it last reached
{
  const edge: SurfaceHeight = x => x <= 5 ? 0.5 * x : null;
  const props = [prop([0, 0, 0])];
  const f = freezeSurfaceFollow(placementSurfaceItems(lookup(props), [0]), edge);
  slideOverSurface(f, 4, 0, edge); // reaches x = 4, ground 2
  const over = slideOverSurface(f, 9, 0, edge);
  check(near(over[0].pos, [9, 2, 0]), 'past the edge it carries on at the last height it rode', show(over[0].pos));
}

// ---- an authored group is one rigid unit
{
  const bowl: SurfaceHeight = x => x * x / 4;
  const props = [prop([0, 0, 0], { assembly: 'group:0000' }), prop([2, 1, 0], { assembly: 'group:0000' })];
  const group = slideOverSurface(freezeSurfaceFollow(placementSurfaceItems(lookup(props), [0, 1]), bowl), 2, 0, bowl);
  // ground change under the members: 0 → 1 and 1 → 4, so the group lifts by their mean, 2
  check(near(group[0].pos, [2, 2, 0]) && near(group[1].pos, [4, 3, 0]), 'a group lifts by its members\' mean ground change',
    `${show(group[0].pos)} ${show(group[1].pos)}`);
  const loose = props.map(p => ({ ...p, assembly: undefined }));
  const apart = slideOverSurface(freezeSurfaceFollow(placementSurfaceItems(lookup(loose), [0, 1]), bowl), 2, 0, bowl);
  check(near(apart[0].pos, [2, 1, 0]) && near(apart[1].pos, [4, 4, 0]), 'loose props each ride their own ground',
    `${show(apart[0].pos)} ${show(apart[1].pos)}`);
}

// ---- Scale pivots on the ground
{
  // a centre-origin box resting on the slope (half a metre tall, origin a quarter up), and a tree sunk 0.3
  const props = [prop([2, 1.25, 0]), prop([-4, -2.3, 3], { scale: 2 })];
  const fBox = freezeSurfaceFollow(placementSurfaceItems(lookup(props), [0]), slope);
  const [box] = scaleOverSurface(fBox, 2, [2, 1.25, 0], slope);
  check(near(box.pos, [2, 1.5, 0]) && box.scale === 2, 'a box grown in place keeps resting on the ground',
    `${show(box.pos)} ×${box.scale}`);
  const [small] = scaleOverSurface(fBox, 0.5, [2, 1.25, 0], slope);
  check(near(small.pos, [2, 1.125, 0]), '…and shrunk too', show(small.pos));
  const [tree] = scaleOverSurface(freezeSurfaceFollow(placementSurfaceItems(lookup(props), [1]), slope), 3, [-4, -2.3, 3], slope);
  check(near(tree.pos, [-4, -2.9, 3]) && tree.scale === 6, 'a sunk tree sinks in proportion', `${show(tree.pos)} ×${tree.scale}`);
}

// ---- a set's Scale spreads its spacing over the ground
{
  const props = [prop([-1, -0.5, 0]), prop([1, 0.5, 2])];
  const spread = scaleOverSurface(freezeSurfaceFollow(placementSurfaceItems(lookup(props), [0, 1]), slope), 2, [0, 0, 1], slope);
  check(near(spread[0].pos, [-2, -1, -1]) && near(spread[1].pos, [2, 1, 3]), 'spread members land on the ground they reach',
    `${show(spread[0].pos)} ${show(spread[1].pos)}`);
  check(spread.every(u => u.scale === 2), 'each member grows by the factor');
}

// ---- no surface underneath: World behaviour
{
  const nowhere: SurfaceHeight = () => null;
  const props = [prop([1, 5, 1])];
  const f = freezeSurfaceFollow(placementSurfaceItems(lookup(props), [0]), nowhere);
  check(f.members[0].ground === null && f.units[0].ground === null, 'a prop over nothing has no ground');
  check(near(slideOverSurface(f, 3, 3, nowhere)[0].pos, [4, 5, 4]), 'it slides level');
  check(near(scaleOverSurface(f, 2, [0, 0, 0], nowhere)[0].pos, [2, 10, 2]), 'it scales about the pivot');
}

// ---- the freeze takes each placement once and skips what is not there
{
  const props = [prop([0, 0, 0])];
  const f = freezeSurfaceFollow(placementSurfaceItems(lookup(props), [0, 0, 3]), slope);
  check(f.members.length === 1 && f.members[0].index === 0, 'repeats count once, missing indices drop');
}

if (failures) process.exitCode = 1;
