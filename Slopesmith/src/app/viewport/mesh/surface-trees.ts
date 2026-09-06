import * as THREE from 'three';
import { MeshBVH, INTERSECTED, NOT_INTERSECTED } from 'three-mesh-bvh';

/**
 * The ray-acceleration trees a surface geometry carries, and how they follow it while it is edited.
 *
 * A terrain sheet is wide and thin, so its bounding sphere covers most of the frame and a stock raycast
 * clears the cheap early-out and walks every triangle — measured at 56 ms per cast on a 278k-vertex mountain,
 * on paths that run per POINTER MOVE (the sculpt / paint hover, prop and gem placement) and per physics tick
 * (the ride's contact probes). Both are answered from a `MeshBVH` instead.
 *
 * The trees are cached ON THE GEOMETRY rather than in one slot per consumer, so the several surfaces in play
 * — the authored terrain, the backdrop a model-edit session places against, a loaded reference — each keep
 * their own instead of evicting each other, and each tree dies with the geometry it indexes.
 *
 * Each is built over a GROUPLESS TWIN that SHARES the geometry's position and index attributes. Groupless
 * because the textured meshes carry one render group per texture run (a big reference is hundreds) and
 * MeshBVH plants a root per group, so every ray would walk them all; `indirect` so the render index keeps its
 * face → cell order and a hit's `faceIndex` still divides by `facesPerCell` to name the cell. Sharing the
 * buffers rather than cloning them is what lets {@link refitSurfaceTrees} follow an edit: the twin reads the
 * new positions the moment the quilt writes them.
 */

/** A surface geometry and the trees built over its buffers. */
export type TreeGeometry = THREE.BufferGeometry & {
  pickBVH?: MeshBVH;
  pickBVHIndex?: THREE.BufferAttribute | null;
  rideBVH?: MeshBVH;
};

/** The groupless twin sharing this geometry's buffers that every tree here indexes. */
function twinOf(geo: THREE.BufferGeometry, pos: THREE.BufferAttribute): THREE.BufferGeometry {
  const twin = new THREE.BufferGeometry();
  twin.setAttribute('position', pos);
  const idx = geo.getIndex();
  if (idx) twin.setIndex(idx);
  return twin;
}

/**
 * The pointer-pick tree for a surface geometry, built on demand (see {@link Stage.pickSurface}).
 *
 * Rebuilt when the index attribute changes: Edit's component-hiding filter re-setIndexes the SAME geometry to
 * collapse hidden patches into degenerate triangles (`Viewport.applyHiddenTerrainIndex`), and a tree built
 * before that would keep picking them. Positions that move under a retained index are a refit rather than a
 * rebuild — see {@link refitSurfaceTrees}, which is three orders of magnitude cheaper than this build.
 *
 * `build` false answers null instead of building, for a caller that would pay it back every frame.
 */
export function pickTree(geo: TreeGeometry, build = true): MeshBVH | null {
  const idx = geo.getIndex();
  if (geo.pickBVH && geo.pickBVHIndex === idx) return geo.pickBVH;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos || !build) return null;
  geo.pickBVH = new MeshBVH(twinOf(geo, pos), { indirect: true });
  geo.pickBVHIndex = idx;
  return geo.pickBVH;
}

/** The contact tree for a surface geometry, built on demand: the ride's per-tick probes (ride/physics.ts) and
 *  the floor the visual effect bodies bounce on (`Viewport.effectGroundAt`) share one, and whichever of them
 *  asks first pays the build. */
export function rideTree(geo: TreeGeometry): MeshBVH | null {
  if (geo.rideBVH) return geo.rideBVH;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) return null;
  geo.rideBVH = new MeshBVH(twinOf(geo, pos), { indirect: true });
  return geo.rideBVH;
}

/**
 * Follow moved vertices in every tree cached on this geometry.
 *
 * An incremental patch re-emit rewrites positions THROUGH the shared buffers and leaves the index alone: the
 * same triangles, somewhere else. That is exactly what `MeshBVH.refit` is for — it recomputes node bounds
 * bottom-up from the triangles as they now stand, and it is exact, because the positions are the only thing
 * the bounds ever depended on. Nothing else in a tree describes where a triangle is, so a refit leaves it as
 * true as a rebuild; what a rebuild would additionally do is re-CHOOSE the split planes, which only affects
 * how much of the tree a query walks.
 *
 * `moved` names where the surface WAS and where it now IS, one box per contiguous run of moved patches. Both
 * halves are load-bearing: the nodes still bound the old surface, so the old shape is what a query can find
 * them by, and the new shape is what those nodes must also come to cover. Every node the boxes reach is
 * refit, ancestors included; the rest of the tree bounds triangles that did not move and is already right.
 */
export function refitSurfaceTrees(geo: TreeGeometry, moved: readonly THREE.Box3[]): void {
  if (!moved.length) return;
  for (const tree of [geo.pickBVH, geo.rideBVH]) {
    if (!tree) continue;
    const nodes = new Set<number>();
    for (const box of moved) {
      tree.shapecast({
        // INTERSECTED even for a node the box swallows whole: CONTAINED ends the entire traversal at the
        // first one it meets, and this is a survey rather than a search.
        intersectsBounds: (bounds, _isLeaf, _score, _depth, nodeIndex) => {
          if (!bounds.intersectsBox(box)) return NOT_INTERSECTED;
          nodes.add(nodeIndex);
          return INTERSECTED;
        },
      });
    }
    // An empty set asks for a whole-tree refit, which is what a mesh small enough to be a single leaf — the
    // one shape the survey above cannot name a node of — needs anyway.
    tree.refit(nodes);
  }
}
