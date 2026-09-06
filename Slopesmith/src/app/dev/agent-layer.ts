import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { Store } from '../state/store';
import type { Viewport } from '../viewport/viewport';
import type { V3 } from '../../core/doc/types';

/**
 * The agent layer (docs/029): makes the 3D viewport addressable to an automated browser client
 * (chrome-devtools MCP) WITHOUT the client editing app source or forging synthetic events.
 *
 * The problem it solves: `take_snapshot` builds its tree from the accessibility tree, and the MCP's
 * `click` / `hover` / `drag` take an element uid — there is no coordinate form. A WebGL canvas is one
 * opaque a11y node, so every prop / rail / gem / light in the scene is unaddressable. Agents worked
 * around that by dispatching hand-built PointerEvents through `evaluate_script`, which needs
 * setPointerCapture stubs, a hand-forged `button: -1` on moves, and devicePixelRatio math.
 *
 * The fix: mirror each interactive scene entity as a transparent, POINTER-EVENTS-NONE DOM node carrying
 * `role=button` + an aria-label. Such a node still appears in the a11y tree, so the MCP can address it by
 * uid — but it is transparent to hit-testing, so the click the MCP dispatches at the node's centre lands
 * on the CANVAS BENEATH as a real, trusted browser event. It flows through the genuine pointer router and
 * raycast picking; nothing here intercepts or synthesizes input. Fidelity is higher than the synthetic
 * path it replaces, not lower.
 *
 * Two rules keep this honest as a regression-testing substrate:
 *   1. The layer NEVER mutates editor state. It projects, labels, and reports. Agents act through real
 *      clicks on real UI, exactly as a person does; only observation goes through the API.
 *   2. Caps are never silent. If the entity budget truncates the mirror, the count is reported by
 *      `snapshot()` and by a labelled node in the tree, so a partial view can't read as a complete one.
 *
 * Off unless BOTH `import.meta.env.DEV` and `?agent=1` hold — normal dev sessions pay nothing, and the
 * module is dynamically imported so it never enters a production bundle. Add `&agentdebug=1` to tint the
 * proxies visible for eyeballing what the agent can address.
 */

/** Interactive entity kinds mirrored into the a11y tree. Rail NODES appear only for the selected rail,
 *  matching the editor's own behaviour (a rail's nodes show once it is selected).
 *
 *  `terrain` is not a doc entity — it is a coarse grid of raycast anchors on the ground surface. Selecting
 *  an existing entity only needs that entity to be addressable, but PLACING one needs an addressable patch
 *  of empty ground, and the MCP cannot click a bare coordinate. Without anchors an agent can inspect a
 *  scene but never build one.
 *
 *  `refprop` is a native reference-world instance (read-only pick / effect host), keyed by its original
 *  Instances.json index. `marker` is a source-marker icon (bulb / speaker / hidden-prop cube). Both live on
 *  the camera-settle clock like anchors: a retail level carries thousands of instances, so they are
 *  enumerated when the view rests, not on every orbit frame. */
export type AgentEntityKind = 'prop' | 'rail' | 'railnode' | 'gem' | 'light' | 'terrain' | 'refprop' | 'marker';

export type AgentEntity = {
  /** Stable-ish address an agent can pass to `locate()`, e.g. `prop:12`, `railnode:3.1`. Doc-index based:
   *  it survives a camera move but not a reorder — the same contract the editor's own selection has. */
  ref: string;
  kind: AgentEntityKind;
  /** The aria-label the proxy node carries — what an agent sees in `take_snapshot`. */
  label: string;
  /** Editor/data-space position (m, Y-up) — the frame the doc stores. Reported for reasoning about the
   *  scene; it is NOT necessarily where the proxy sits (see `world`). */
  pos: V3;
  /** World-space point the proxy is actually placed at, when it differs from `pos`.
   *
   *  A placement's `pos` is its ANCHOR, which for most models sits on the ground at the model's foot — so a
   *  proxy there overlays bare terrain, and the click raycast selects the ground instead of the prop.
   *  Measured: clicking a path-marker's anchor left `selectedProp` null while a prop whose geometry happens
   *  to straddle its origin selected fine. Props therefore aim at their rendered bounding-sphere centre. */
  world?: THREE.Vector3;
  /** CSS-pixel viewport coords of the projected point, or null when off-screen / behind the camera. */
  screen: { x: number; y: number } | null;
  /** Distance from the camera in metres, for the nearest-first budget. */
  dist: number;
  selected: boolean;
};

export type AgentLayer = {
  /** Called by the host at the end of a successful rebuild — drives `settled()` and re-syncs the mirror. */
  onRendered(): void;
  /** Called by the host's rebuild error boundary; surfaces what the funnel otherwise only logs. */
  onBuildError(e: unknown): void;
  dispose(): void;
};

/** Nearest-first budget. The mirror is a11y-tree noise as much as it is a tool, and a big level can carry
 *  hundreds of placements; past this the tree stops being readable. Overflow is REPORTED, never silent. */
const MAX_PROXIES = 150;

/** Reference-mirror budgets. A retail level ships THOUSANDS of native instances and hundreds of source
 *  icons; the nearest few dozen of each are published and the remainder is counted in the tree note. */
const REFPROP_MAX = 60;
const MARKER_MAX = 60;

/** Proxy hit-box, CSS px. Large enough that the projected centre is unambiguous, small enough that
 *  neighbouring entities stay separately addressable. Overlap is harmless — the nodes are transparent to
 *  hit-testing, so a click always reaches the canvas regardless of which proxy owns the pixel. */
const PROXY_SIZE = 20;

/** Metres of slack in the terrain-occlusion test, so an entity resting ON the ground does not occlude
 *  itself through floating-point noise. A genuinely buried entity clears this by orders of magnitude. */
const OCCLUSION_MARGIN = 1;

function fmt(n: number): number { return Math.round(n * 100) / 100; }

export function installAgentLayer(deps: {
  store: Store;
  viewport: Viewport;
  /** The element the renderer's canvas lives in — supplies the projection rect. */
  container: HTMLElement;
}): AgentLayer {
  const { store, viewport, container } = deps;
  const params = new URLSearchParams(location.search);
  const debugVisible = params.has('agentdebug');

  // The proxy host. pointer-events:none is load-bearing and inherited by every child: it is what makes a
  // click pass THROUGH to the canvas instead of being swallowed here.
  const host = document.createElement('div');
  host.id = 'agent-layer';
  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', 'Scene entities (agent layer)');
  Object.assign(host.style, {
    position: 'fixed', left: '0', top: '0', width: '100%', height: '100%',
    pointerEvents: 'none', zIndex: '9000',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(host);

  // A labelled node that reports truncation into the tree itself, so an agent reading only the snapshot
  // still learns the mirror is partial.
  const overflowNode = document.createElement('div');
  overflowNode.setAttribute('role', 'note');
  overflowNode.style.display = 'none';
  host.appendChild(overflowNode);

  // A second note for the reference mirror, on its own clock (see syncRefEntities).
  const refNote = document.createElement('div');
  refNote.setAttribute('role', 'note');
  refNote.style.display = 'none';
  host.appendChild(refNote);

  // Entities, anchors and the reference mirror run on different clocks (every dirty frame vs camera-settle
  // only), so they keep separate proxy maps — a shared map would have each sync pruning the others' nodes.
  const entityProxies = new Map<string, HTMLDivElement>();
  const anchorProxies = new Map<string, HTMLDivElement>();
  const refProxies = new Map<string, HTMLDivElement>();
  let lastVisible: AgentEntity[] = [];
  let lastAnchors: AgentEntity[] = [];
  let lastRef: AgentEntity[] = [];
  let refShown = 0; let refTruncated = 0; let refOccluded = 0;
  let markerShown = 0; let markerTruncated = 0;
  let truncated = 0;
  let occludedCount = 0;
  let occludedRefs = new Set<string>();
  let renderSeq = 0;
  const buildErrors: { at: number; message: string }[] = [];

  // ---- entity enumeration -------------------------------------------------------------------------
  // Read straight off the doc rather than reaching into viewport layer internals: the doc is the same
  // ground truth the renderer consumes, and it keeps this module's coupling to two calls (dataToWorld,
  // camera) instead of the whole layer surface.

  type Collected = { ref: string; kind: AgentEntityKind; label: string; pos: V3; selected: boolean;
    world?: THREE.Vector3 };

  /** Effective visibility: THREE hides a whole subtree when any ancestor is invisible, so the object's own
   *  flag is not enough. */
  function shown(o: THREE.Object3D | null | undefined): boolean {
    let n: THREE.Object3D | null = o ?? null;
    if (!n) return false;
    while (n) { if (!n.visible) return false; n = n.parent; }
    return true;
  }

  /**
   * Which entity kinds are currently RENDERED. The view pills gate whole layers — 'Tricks' hides rails and
   * gems together, 'Props' hides placements, and 'Sources' hides free-light markers — and a hidden layer is not
   * pickable, so a proxy over it would be a click target that can never select anything.
   *
   * This was not hypothetical: a rail proxy sat on bare terrain because the Tricks view was off, and every
   * click on it silently selected nothing. Mirroring only what is on screen keeps the tree honest, and
   * `hiddenKinds` in snapshot() says which pill to click to get the rest back.
   */
  function visibleKinds() {
    return {
      prop: shown(viewport.props.placedPropGroup),
      rail: shown(viewport.rails.railGroup),
      gem: shown(viewport.gems.gemGroup),
      light: shown(viewport.lights.freeLightGroup),
    };
  }

  function collect(): Collected[] {
    const out: Collected[] = [];
    const doc = store.mdoc;
    const vis = visibleKinds();

    if (vis.prop) (doc.props ?? []).forEach((p, i) => {
      const sel = store.selectedProp === i || store.multiSel.includes(i);
      // Aim at the rendered geometry's centre, not the placement anchor — see AgentEntity.world. Falls back
      // to the anchor for placements with no id (pre-migration saves) or nothing rendered yet.
      const sphere = p.id ? viewport.props.propWorldSphere(p.id) : null;
      out.push({
        ref: `prop:${i}`, kind: 'prop', pos: p.pos, selected: sel,
        world: sphere?.center,
        label: `Prop ${i}: ${p.name}${p.group ? ' (group)' : ''}`,
      });
    });

    if (vis.rail) (doc.rails ?? []).forEach((r, i) => {
      // A rail with no nodes renders nothing, so a proxy for it would be a click target that can never
      // select anything. `snapshot().counts.rails` still reports it — the mirror just doesn't lie about it.
      if (!r.nodes.length) return;
      // Aim at a NODE, not the node centroid. The tube follows a Catmull-Rom spline through the nodes, and
      // on a bent rail the centroid sits off the curve entirely — measured: a centroid-seated proxy on a
      // 3-node rail selected nothing. A control point is always on the tube's centreline.
      out.push({
        ref: `rail:${i}`, kind: 'rail', pos: r.nodes[Math.floor(r.nodes.length / 2)],
        selected: store.selectedRail === i,
        label: `Rail ${i}${r.name ? `: ${r.name}` : ''} (${r.nodes.length} nodes)`,
      });
      // Nodes are addressable only while their rail is selected — mirroring the editor, and keeping a
      // multi-rail level from flooding the tree with node proxies.
      if (store.selectedRail === i) {
        r.nodes.forEach((n, j) => out.push({
          ref: `railnode:${i}.${j}`, kind: 'railnode', pos: n,
          selected: store.selectedNode === j,
          label: `Rail ${i} node ${j}`,
        }));
      }
    });

    // Gems and lights are addressed by the id the document gives them, which is already `gem:NNNN` /
    // `light:NNNN` — so a ref an agent is holding names the same object after something below it is deleted.
    if (vis.gem) (doc.gems ?? []).forEach((g, i) => out.push({
      ref: g.id ?? `gem:${i}`, kind: 'gem', pos: g.pos, selected: store.selectedGem === g.id,
      label: `Gem ${i} (tier ${g.value ?? 1})`,
    }));

    if (vis.light) (doc.lights ?? []).forEach((l, i) => out.push({
      ref: l.id ?? `light:${i}`, kind: 'light', pos: l.pos, selected: store.selectedLight === l.id,
      label: `Light ${i}: ${l.kind}${l.name ? ` ${l.name}` : ''} ${l.color}`,
    }));

    return out;
  }

  // ---- terrain anchors ----------------------------------------------------------------------------
  // A grid of screen points raycast onto the ground mesh. Each hit becomes an addressable proxy, so
  // "place a gem over there" is expressible as a uid click. The label carries the data-space landing point
  // so an agent can choose an anchor deliberately rather than clicking blind.

  const anchorRay = new THREE.Raycaster();
  const mInv = new THREE.Matrix4();

  /** How many screen points to CAST (n x n). Terrain is often a diagonal ribbon rather than a full-frame
   *  surface, so a coarse grid drops through the gaps and reports "no ground" on a view full of it — a 4x4
   *  grid measured 0/16 hits on a framed map whose centre cast hit. Sample densely, publish sparsely. */
  let anchorSamples = 16;
  /** How many hits to actually MIRROR. The a11y tree is a reading surface; past ~20 ground anchors it stops
   *  being scannable and starts burying the UI controls. */
  let maxAnchors = 20;

  const COLS = 'ABCDEFGHIJKLMNOP';

  /** World -> editor/data space, the inverse of viewport.dataToWorld (the chirality flip). */
  function worldToData(w: THREE.Vector3): V3 {
    const root = viewport.stage.worldRoot;
    root.updateWorldMatrix(true, false);
    mInv.copy(root.matrixWorld).invert();
    const p = w.clone().applyMatrix4(mInv);
    return [p.x, p.y, p.z];
  }

  // Stock THREE.Raycaster against this ground mesh measured ~3 SECONDS for 100 casts (a ~93k-triangle
  // geometry with per-texture render groups, walked linearly per cast). A BVH turns each cast into a tree
  // descent and the same sweep into single-digit ms. The viewport builds one for gizmo slides but keeps it
  // private and rebuilds per call, so this owns a cached twin on the same recipe as buildGeometryBVH:
  // clone position (+ index) into an isolated geometry so nothing here can disturb the render path.
  let bvh: MeshBVH | null = null;
  let bvhKey = '';
  let bvhBuildMs = 0;
  function terrainBVH(mesh: THREE.Mesh): MeshBVH | null {
    // A rebuild can replace the terrain geometry wholesale, so key on identity AND the render counter.
    const key = `${mesh.geometry.uuid}:${renderSeq}`;
    if (bvh && bvhKey === key) return bvh;
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return null;
    const t0 = performance.now();
    const twin = new THREE.BufferGeometry();
    twin.setAttribute('position', pos.clone());
    const idx = mesh.geometry.getIndex();
    if (idx) twin.setIndex(idx.clone());
    bvh = new MeshBVH(twin);
    bvhKey = key;
    bvhBuildMs = Math.round(performance.now() - t0);
    return bvh;
  }

  const localRay = new THREE.Ray();
  const meshInv = new THREE.Matrix4();

  /**
   * Cast the sample grid and keep an evenly-spread subset of the hits.
   *
   * Runs only from the settle path: the BVH build is amortised across a whole camera rest, and rebuilding
   * it mid-orbit would be the one genuinely expensive thing this layer could do.
   */
  function collectAnchors(rect: DOMRect): AgentEntity[] {
    const mesh = viewport.stage.terrainMesh;
    if (!mesh || anchorSamples <= 0 || maxAnchors <= 0) return [];
    const tree = terrainBVH(mesh);
    if (!tree) return [];
    const cam = viewport.camera;
    mesh.updateWorldMatrix(true, false);
    meshInv.copy(mesh.matrixWorld).invert();

    const hits: { fx: number; fy: number; data: V3; dist: number }[] = [];
    for (let r = 0; r < anchorSamples; r++) {
      for (let c = 0; c < anchorSamples; c++) {
        const fx = (c + 0.5) / anchorSamples;
        const fy = (r + 0.5) / anchorSamples;
        anchorRay.setFromCamera(new THREE.Vector2(fx * 2 - 1, -(fy * 2 - 1)), cam);
        // The BVH indexes geometry-local space; DoubleSide because worldRoot's z-flip inverts winding and a
        // front-face-only test would drop every hit.
        localRay.copy(anchorRay.ray).applyMatrix4(meshInv);
        const hit = tree.raycastFirst(localRay, THREE.DoubleSide);
        if (!hit) continue; // that screen point sees sky, not ground
        const world = hit.point.clone().applyMatrix4(mesh.matrixWorld);
        hits.push({ fx, fy, data: worldToData(world), dist: hit.distance });
      }
    }
    // Evenly stride the hit list rather than taking the first N: the samples are emitted in raster order, so
    // a plain slice would crowd every anchor into the top band of the screen.
    const stride = Math.max(1, Math.ceil(hits.length / maxAnchors));
    const kept = hits.filter((_, i) => i % stride === 0).slice(0, maxAnchors);
    return kept.map((h, i) => ({
      ref: `terrain:${COLS[i % COLS.length]}${Math.floor(i / COLS.length) + 1}`,
      kind: 'terrain' as const,
      label: `Terrain ${COLS[i % COLS.length]}${Math.floor(i / COLS.length) + 1}`
        + ` (x ${Math.round(h.data[0])}, y ${Math.round(h.data[1])}, z ${Math.round(h.data[2])})`,
      pos: h.data,
      // The anchor IS the screen point we cast through, so it needs no reprojection.
      screen: { x: rect.left + h.fx * rect.width, y: rect.top + h.fy * rect.height },
      dist: h.dist,
      selected: false,
    }));
  }

  // ---- projection ---------------------------------------------------------------------------------

  const vTmp = new THREE.Vector3();

  /** Data-space point (or an explicit world point) -> CSS-pixel viewport coords; null when off screen. */
  function project(pos: V3, rect: DOMRect, world?: THREE.Vector3): { screen: { x: number; y: number } | null; dist: number } {
    const cam = viewport.camera;
    cam.updateMatrixWorld();
    if (world) vTmp.copy(world);
    else { const w = viewport.dataToWorld(pos); vTmp.set(w[0], w[1], w[2]); }
    const dist = vTmp.distanceTo(cam.position);

    // View space first: a perspective camera looks down -Z, so a positive z is behind it and would
    // project to a mirrored on-screen point. Ortho has no such singularity, so it skips the test.
    vTmp.applyMatrix4(cam.matrixWorldInverse);
    if ((cam as THREE.PerspectiveCamera).isPerspectiveCamera && vTmp.z > -0.01) return { screen: null, dist };

    // applyMatrix4 performs the perspective divide, so this lands in NDC.
    vTmp.applyMatrix4(cam.projectionMatrix);
    if (vTmp.x < -1 || vTmp.x > 1 || vTmp.y < -1 || vTmp.y > 1) return { screen: null, dist };

    return {
      screen: {
        x: rect.left + (vTmp.x * 0.5 + 0.5) * rect.width,
        y: rect.top + (-vTmp.y * 0.5 + 0.5) * rect.height,
      },
      dist,
    };
  }

  // ---- mirror sync --------------------------------------------------------------------------------

  /** Create-or-update one proxy node, keyed by ref, inside the given map. */
  function upsert(map: Map<string, HTMLDivElement>, e: AgentEntity) {
    let el = map.get(e.ref);
    if (!el) {
      el = document.createElement('div');
      el.setAttribute('role', 'button');
      el.dataset.agentRef = e.ref;
      const tint = e.kind === 'terrain' ? '120,220,140' : '0,200,255';
      Object.assign(el.style, {
        position: 'fixed', width: `${PROXY_SIZE}px`, height: `${PROXY_SIZE}px`,
        pointerEvents: 'none', // load-bearing: this is what lets the click reach the canvas
        background: debugVisible ? `rgba(${tint},.30)` : 'transparent',
        outline: debugVisible ? `1px solid rgba(${tint},.9)` : 'none',
        borderRadius: '50%',
      } satisfies Partial<CSSStyleDeclaration>);
      host.appendChild(el);
      map.set(e.ref, el);
    }
    // aria-pressed surfaces selection the same way the mode buttons do, so an agent can read what is
    // selected straight out of the snapshot instead of probing for it.
    el.setAttribute('aria-label', e.label);
    el.setAttribute('aria-pressed', String(e.selected));
    el.style.left = `${e.screen!.x - PROXY_SIZE / 2}px`;
    el.style.top = `${e.screen!.y - PROXY_SIZE / 2}px`;
  }

  function prune(map: Map<string, HTMLDivElement>, live: Set<string>) {
    for (const [ref, el] of map) {
      if (live.has(ref)) continue;
      el.remove();
      map.delete(ref);
    }
  }

  /**
   * Is the terrain in front of this entity at its own screen point?
   *
   * A proxy over a buried entity is the worst kind of lie the mirror can tell: the node looks addressable,
   * the click dispatches cleanly, and the picker selects the ground instead — silently. Measured on a rail
   * whose nodes had ended up under the surface: proxy at 326 m, `pickAt` reported terrain at 204 m, and
   * every click on it did nothing.
   *
   * Reuses the cached anchor BVH, so this is a tree descent per entity, not a mesh walk.
   */
  function occluded(e: { screen: { x: number; y: number } | null; dist: number }, rect: DOMRect): boolean {
    if (!e.screen) return false;
    const mesh = viewport.stage.terrainMesh;
    if (!mesh) return false;
    const tree = terrainBVH(mesh);
    if (!tree) return false;
    const ndcX = ((e.screen.x - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((e.screen.y - rect.top) / rect.height) * 2 - 1);
    anchorRay.setFromCamera(new THREE.Vector2(ndcX, ndcY), viewport.camera);
    mesh.updateWorldMatrix(true, false);
    meshInv.copy(mesh.matrixWorld).invert();
    localRay.copy(anchorRay.ray).applyMatrix4(meshInv);
    const hit = tree.raycastFirst(localRay, THREE.DoubleSide);
    // OCCLUSION_MARGIN keeps an entity resting ON the ground from occluding itself through float noise;
    // a genuinely buried entity clears it by orders of magnitude.
    return !!hit && hit.distance < e.dist - OCCLUSION_MARGIN;
  }

  /** Doc entities: matrix work plus one BVH descent each, cheap enough to run on every dirty frame. */
  function syncEntities() {
    const rect = container.getBoundingClientRect();
    const visible = collect().map(e => {
      const { screen, dist } = project(e.pos, rect, e.world);
      return { ...e, screen, dist };
    });

    // Nearest-first, on-screen only: the budget should spend itself on what an agent can actually click.
    const candidates = visible.filter(e => e.screen).sort((a, b) => a.dist - b.dist);
    const buried = candidates.filter(e => occluded(e, rect));
    const buriedRefs = new Set(buried.map(e => e.ref));
    occludedRefs = buriedRefs;
    occludedCount = buried.length;
    const onScreen = candidates.filter(e => !buriedRefs.has(e.ref));
    const shown = onScreen.slice(0, MAX_PROXIES);
    truncated = onScreen.length - shown.length;
    lastVisible = visible;

    const live = new Set<string>();
    for (const e of shown) { live.add(e.ref); upsert(entityProxies, e); }
    prune(entityProxies, live);

    // Everything the mirror is NOT showing, and why — stated in the tree itself so an agent reading only
    // the snapshot cannot mistake a filtered view for a complete one.
    const notes: string[] = [];
    if (truncated > 0) {
      notes.push(`showing nearest ${shown.length} of ${onScreen.length} on-screen entities, ${truncated} over budget (zoom in or select fewer)`);
    }
    const hidden = hiddenKinds();
    if (hidden.length) {
      notes.push(`${hidden.join(', ')} hidden by a View toggle and therefore NOT clickable — turn the matching view pill on ('Tricks' for rails + gems, 'Props', 'Sources' for lights)`);
    }
    if (occludedCount > 0) {
      notes.push(`${occludedCount} on-screen ${occludedCount === 1 ? 'entity is' : 'entities are'} behind the terrain and not clickable from this angle — orbit or zoom to bring ${occludedCount === 1 ? 'it' : 'them'} into view`);
    }
    if (notes.length) {
      overflowNode.style.display = '';
      overflowNode.setAttribute('aria-label', `Agent layer: ${notes.join('; ')}.`);
    } else {
      overflowNode.style.display = 'none';
      overflowNode.removeAttribute('aria-label');
    }
  }

  /** Entity kinds present in the doc but hidden by a view toggle, so absent from the mirror. */
  function hiddenKinds(): string[] {
    const vis = visibleKinds();
    const doc = store.mdoc;
    const out: string[] = [];
    if (!vis.prop && (doc.props ?? []).length) out.push('props');
    if (!vis.rail && (doc.rails ?? []).length) out.push('rails');
    if (!vis.gem && (doc.gems ?? []).length) out.push('gems');
    if (!vis.light && (doc.lights ?? []).length) out.push('lights');
    return out;
  }

  /** Ground anchors: raycast-backed, so only ever run from the settle path. */
  function syncAnchors() {
    const rect = container.getBoundingClientRect();
    lastAnchors = collectAnchors(rect);
    const live = new Set<string>();
    for (const e of lastAnchors) { live.add(e.ref); upsert(anchorProxies, e); }
    prune(anchorProxies, live);
  }

  /** Anchors are stale the moment the camera moves; dropping them beats publishing coordinates that would
   *  send a click to the wrong patch of ground. They return ~a frame after the camera stops. */
  function dropAnchors() {
    lastAnchors = [];
    prune(anchorProxies, new Set());
  }

  // ---- reference mirror ---------------------------------------------------------------------------
  // Native reference-world instances and source-marker icons. Read straight off the rendered layers (the
  // same InstancedMesh / Points state the picker raycasts) because the reference has no authored doc to
  // enumerate. On the settle clock: a retail level ships thousands of instances, and walking them per
  // orbit frame is the one cost this layer must not pay.

  const instMat = new THREE.Matrix4();
  const refPoint = new THREE.Vector3();

  /** Visible native instances across the props / tricks / effect-proxy groups, deduped by source index
   *  (sibling material submeshes repeat the same instance list). Hidden instances batch with a zero-scale
   *  matrix and are skipped — they are exactly what the `marker` mirror addresses instead. */
  function collectRefProps(rect: DOMRect): AgentEntity[] {
    const groups = new Set<THREE.Object3D>([
      ...viewport.refDecor.propPickGroups, ...viewport.refDecor.effectPropGroups]);
    const seen = new Set<number>();
    const out: AgentEntity[] = [];
    for (const group of groups) {
      if (!shown(group)) continue;
      for (const object of group.children) {
        const mesh = object as THREE.InstancedMesh;
        if (!mesh.isInstancedMesh || !mesh.visible) continue;
        const insts = mesh.userData.propInsts as { sourceIndex: number }[] | undefined;
        if (!insts?.length) continue;
        // Aim at the model's bounding-sphere centre, not the instance origin — same reasoning as authored
        // props: the origin sits at the model's foot, where a click raycast finds bare ground instead.
        if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
        const centre = mesh.geometry.boundingSphere?.center;
        mesh.updateWorldMatrix(true, false);
        for (let k = 0; k < insts.length; k++) {
          const sourceIndex = insts[k].sourceIndex;
          if (seen.has(sourceIndex)) continue;
          mesh.getMatrixAt(k, instMat);
          const m = instMat.elements;
          if (m[0] * m[0] + m[1] * m[1] + m[2] * m[2] < 1e-12) continue; // zero-scale = hidden instance
          seen.add(sourceIndex);
          const world = refPoint.copy(centre ?? new THREE.Vector3())
            .applyMatrix4(instMat).applyMatrix4(mesh.matrixWorld).clone();
          const pos = worldToData(world);
          const { screen, dist } = project(pos, rect, world);
          out.push({
            ref: `refprop:${sourceIndex}`, kind: 'refprop', world, pos, screen, dist,
            label: `Ref prop ${sourceIndex}: ${mesh.name}`,
            selected: store.selectedRefProp?.sourceIndex === sourceIndex,
          });
        }
      }
    }
    return out;
  }

  /** Visible source-marker icons (bulbs / speakers / hidden-prop cubes), authored and reference. The
   *  marker clouds optionally publish per-index labels and source indices in their userData, which turns
   *  "Marker prop 3" into "Marker prop: Mdl_FWTrigger_1000" — reference-decor supplies both. */
  function collectMarkers(rect: DOMRect): AgentEntity[] {
    const out: AgentEntity[] = [];
    const roots = [viewport.lights.authoredLightsGroup, ...viewport.refDecor.sourcePickGroups];
    for (const root of roots) root.traverse(object => {
      const cloud = object as THREE.Points;
      const kind = cloud.userData?.sourceKind as string | undefined;
      const origin = cloud.userData?.sourceOrigin as string | undefined;
      if (!cloud.isPoints || !kind || !origin || !shown(cloud)) return;
      const positions = cloud.geometry.getAttribute('position');
      if (!positions) return;
      const labels = cloud.userData.sourceLabels as string[] | undefined;
      const sourceIndices = cloud.userData.sourceSourceIndices as number[] | undefined;
      cloud.updateWorldMatrix(true, false);
      for (let i = 0; i < positions.count; i++) {
        const world = refPoint.fromBufferAttribute(positions, i).applyMatrix4(cloud.matrixWorld).clone();
        const pos = worldToData(world);
        const { screen, dist } = project(pos, rect, world);
        const sourceIndex = sourceIndices?.[i];
        out.push({
          ref: `marker:${origin}:${kind}:${i}`, kind: 'marker', world, pos, screen, dist,
          label: `Marker ${kind}${labels?.[i] ? `: ${labels[i]}` : ` ${i}`} (${origin})`,
          selected: sourceIndex !== undefined && store.selectedRefProp?.sourceIndex === sourceIndex,
        });
      }
    });
    return out;
  }

  /** Publish the reference mirror: nearest-first under each budget. Instance occlusion is walked only
   *  until the budget fills, so the BVH cost stays bounded no matter how big the level is. Markers skip
   *  the occlusion test entirely — they draw (and click) x-ray by design. */
  function syncRefEntities() {
    const rect = container.getBoundingClientRect();
    const instances = collectRefProps(rect).filter(e => e.screen).sort((a, b) => a.dist - b.dist);
    const keptInstances: AgentEntity[] = [];
    let buried = 0;
    for (const e of instances) {
      if (keptInstances.length >= REFPROP_MAX) break;
      if (occluded(e, rect)) { buried++; continue; }
      keptInstances.push(e);
    }
    refShown = keptInstances.length;
    refOccluded = buried;
    refTruncated = instances.length - keptInstances.length - buried;
    const markers = collectMarkers(rect).filter(e => e.screen).sort((a, b) => a.dist - b.dist);
    const keptMarkers = markers.slice(0, MARKER_MAX);
    markerShown = keptMarkers.length;
    markerTruncated = markers.length - keptMarkers.length;

    lastRef = [...keptInstances, ...keptMarkers];
    const live = new Set<string>();
    for (const e of lastRef) { live.add(e.ref); upsert(refProxies, e); }
    prune(refProxies, live);

    const notes: string[] = [];
    if (refTruncated > 0) notes.push(`showing nearest ${refShown} of ${instances.length} on-screen reference props, ${refTruncated} over budget (zoom in)`);
    if (refOccluded > 0) notes.push(`${refOccluded} reference props behind the terrain from this angle`);
    if (markerTruncated > 0) notes.push(`showing nearest ${markerShown} of ${markers.length} source markers, ${markerTruncated} over budget`);
    if (notes.length) {
      refNote.style.display = '';
      refNote.setAttribute('aria-label', `Agent layer (reference): ${notes.join('; ')}.`);
    } else {
      refNote.style.display = 'none';
      refNote.removeAttribute('aria-label');
    }
  }

  /** Like anchors, the reference mirror is stale the moment the camera moves — drop rather than lie. */
  function dropRef() {
    lastRef = [];
    refShown = 0; refTruncated = 0; refOccluded = 0; markerShown = 0; markerTruncated = 0;
    prune(refProxies, new Set());
    refNote.style.display = 'none';
  }

  function sync() { syncEntities(); syncAnchors(); syncRefEntities(); }

  // Re-sync only when something that moves a proxy or changes its label actually changed. Idle frames cost
  // one string build + compare, so the layer is free to leave on for a whole session.
  //
  // Selection has to be in the signature, not just the render counter: picking a prop mutates the store and
  // reseats the gizmo WITHOUT scheduling a rebuild (rebuild is for document mutations), so a selection-only
  // signature miss leaves `aria-pressed` and `entities()` reporting a stale selection immediately after the
  // very click that changed it.
  let lastSig = '';
  let lastCamSig = '';
  let raf = 0;
  /** Wall-clock ms the camera has to hold still before the raycast-backed anchors are recomputed. Long
   *  enough that an orbit drag never pays for them, short enough to be ready before an agent's next call. */
  const ANCHOR_SETTLE_MS = 150;
  let camStillSince = 0;
  let anchorsFresh = false;
  let anchorSeq = -1;

  function cameraSig(): string {
    const c = viewport.camera;
    return [
      fmt(c.position.x), fmt(c.position.y), fmt(c.position.z),
      fmt(c.quaternion.x), fmt(c.quaternion.y), fmt(c.quaternion.z), fmt(c.quaternion.w),
      fmt(c.zoom), (c as THREE.OrthographicCamera).isOrthographicCamera ? 'o' : 'p',
    ].join(',');
  }
  function stateSig(): string {
    const s = store;
    const v = visibleKinds();
    return [
      cameraSig(), renderSeq, s.currentMode,
      s.selectedProp, s.multiSel.join('|'), s.selectedRail, s.selectedNode, s.selectedGem, s.selectedLight,
      s.selectedRefProp?.sourceIndex, // the reference mirror's aria-pressed reads off this
      // View pills gate whole layers in and out of the mirror, and they change nothing else in this list.
      v.prop, v.rail, v.gem, v.light,
      // The reference mirror's own gates: the Props/Tricks/Effects prop groups and the Sources markers all
      // flip visibility without a rebuild or camera move, so their shown state must dirty the signature.
      [...viewport.refDecor.propPickGroups, ...viewport.refDecor.effectPropGroups,
        ...viewport.refDecor.sourcePickGroups].map(g => shown(g) && g.children.length > 0 ? 1 : 0).join(''),
    ].join(',');
  }

  function tick() {
    try {
      const sig = stateSig();
      if (sig !== lastSig) {
        lastSig = sig;
        syncEntities();
        // A selection / pill flip with the camera at rest must refresh the reference mirror's pressed
        // state too — the click that selected a marker would otherwise read as unselected.
        if (anchorsFresh && cameraSig() === lastCamSig) syncRefEntities();
      }

      // Anchors and the reference mirror follow the camera on a settle timer instead of the dirty flag,
      // because each anchor costs a raycast against the full ground mesh and a retail level carries
      // thousands of reference instances. A rebuild also invalidates them — sculpting moves the ground
      // out from under coordinates already published to the tree.
      const camSig = cameraSig();
      if (camSig !== lastCamSig) {
        lastCamSig = camSig;
        camStillSince = performance.now();
        if (anchorsFresh) { dropAnchors(); dropRef(); anchorsFresh = false; }
      } else if (renderSeq !== anchorSeq) {
        anchorsFresh = false;
        camStillSince = performance.now();
        anchorSeq = renderSeq;
      } else if (!anchorsFresh && performance.now() - camStillSince >= ANCHOR_SETTLE_MS) {
        syncAnchors();
        syncRefEntities();
        anchorsFresh = true;
      }
    } catch (e) {
      buildErrors.push({ at: Date.now(), message: `agent-layer sync: ${String(e)}` });
    }
    raf = requestAnimationFrame(tick);
  }
  raf = requestAnimationFrame(tick);

  // ---- observation API ----------------------------------------------------------------------------
  // Strictly read-only. Anything that would MUTATE editor state is deliberately absent: an agent that
  // calls setMode() directly is not testing the button, and a regression suite built on that proves
  // nothing about the UI. Act through clicks; observe through here.

  const api = {
    /** Editor state in one call — mode, selection, counts, camera, last build error, mirror health. */
    snapshot() {
      const doc = store.mdoc;
      const referencePropStats = viewport.refDecor.renderStats();
      return {
        mode: store.currentMode,
        docName: doc.name,
        counts: {
          props: (doc.props ?? []).length,
          rails: (doc.rails ?? []).length,
          gems: (doc.gems ?? []).length,
          lights: (doc.lights ?? []).length,
        },
        selection: {
          prop: store.selectedProp, props: [...store.multiSel],
          rail: store.selectedRail, railNode: store.selectedNode,
          gem: store.selectedGem, light: store.selectedLight,
          knot: store.selected, corner: store.selectedCorner,
          refProp: store.selectedRefProp
            ? { name: store.selectedRefProp.name, sourceIndex: store.selectedRefProp.sourceIndex ?? null }
            : null,
          refLight: store.selectedRefLight
            ? { level: store.selectedRefLight.level, kind: store.selectedRefLight.light.kind }
            : null,
        },
        armedProp: store.armedProp ? { ...store.armedProp } : null,
        // Light glints (docs/047) draw entirely in a shader with no time term and no proxy of their own, so
        // the counts are the only way to tell "the gate admitted nothing" from "the sparkle is not drawing".
        glints: { authored: viewport.glints.authoredCount, reference: viewport.glints.referenceCount },
        camera: {
          pos: viewport.camera.position.toArray().map(fmt),
          ortho: !!(viewport.camera as THREE.OrthographicCamera).isOrthographicCamera,
        },
        // What the last completed frame actually submitted, off the renderer's own counters (they reset per
        // frame). Culling and batching work is otherwise unobservable from here: the picture looks the same
        // whether the course drew once or ten times over, and only these two numbers say which happened.
        render: {
          calls: viewport.stage.renderer.info.render.calls,
          triangles: viewport.stage.renderer.info.render.triangles,
          geometries: viewport.stage.renderer.info.memory.geometries,
          // Which reference-prop path this level landed on. Batched slots frustum-cull per INSTANCE inside
          // BatchedMesh.onBeforeRender; isolated (InstancedMesh) draws and the merged no-multi-draw fallback
          // cull only as whole map-spanning objects. So this is the number that says whether a spatial split
          // of the props would buy anything, the way it did for the terrain quilt.
          propBatchDraws: referencePropStats.batchDraws,
          propBatchSlots: referencePropStats.batchSlots,
          propIsolatedDraws: referencePropStats.isolatedDraws,
          propIsolatedSlots: referencePropStats.isolatedSlots,
          propIsolation: referencePropStats.isolation,
          multiDraw: viewport.stage.renderer.extensions.has('WEBGL_multi_draw'),
          // The ride's range gate (scene/range-cull). `range: 0` means it is off, which is the editor's
          // normal state — it arms only for a ride, so a drawn/total pair here is a mid-ride reading.
          range: viewport.rangeCullStats(),
        },
        agentLayer: {
          mirrored: entityProxies.size,
          truncated,
          // In the doc but hidden by a View toggle, so deliberately absent from the mirror: they are not
          // pickable, and a proxy over an unrendered entity would be a click target that selects nothing.
          hiddenKinds: hiddenKinds(),
          // On screen but behind the terrain, so dropped from the mirror rather than published as a click
          // target that would silently select the ground instead.
          occluded: occludedCount,
          anchors: anchorProxies.size,
          anchorsFresh, // false while the camera is still settling; anchors AND the reference mirror are absent until it is true
          anchorSamples,
          // The reference-world mirror (native instances + source-marker icons), same settle clock.
          refMirror: {
            refProps: refShown, refPropsTruncated: refTruncated, refPropsOccluded: refOccluded,
            markers: markerShown, markersTruncated: markerTruncated,
          },
          renderSeq,
        },
        lastBuildError: buildErrors.length ? buildErrors[buildErrors.length - 1] : null,
      };
    },

    /** Every enumerated entity with its projected screen point (null = not on screen). */
    entities(kind?: AgentEntityKind) {
      const all = [...lastVisible, ...lastAnchors, ...lastRef];
      return (kind ? all.filter(e => e.kind === kind) : all).map(e => {
        const occl = occludedRefs.has(e.ref);
        return {
          ref: e.ref, kind: e.kind, label: e.label, screen: e.screen, dist: fmt(e.dist),
          selected: e.selected,
          occluded: occl,
          // The one field to branch on: whether a proxy for this entity exists in the tree right now.
          // Off-screen and terrain-buried entities are listed here for reasoning, but cannot be clicked.
          clickable: !!e.screen && !occl,
        };
      });
    },

    /** One entity by ref, e.g. `locate('prop:12')`. Null when unknown. */
    locate(ref: string) {
      return this.entities().find(e => e.ref === ref) ?? null;
    },

    /** The live document (structured-clone safe). */
    doc() {
      return JSON.parse(JSON.stringify(store.mdoc)) as unknown;
    },

    /**
     * Resolve once the rebuild funnel is quiet. `rebuild.ts` coalesces a burst of edits into one render on
     * the next animation frame, so an agent that reads straight after an action races the rebuild; this
     * removes the guesswork. `{rendered:false}` means nothing was pending, which is a normal answer.
     */
    settled(timeoutMs = 2000) {
      const start = renderSeq;
      const deadline = Date.now() + timeoutMs;
      return new Promise<{ rendered: boolean; seq: number; timedOut: boolean }>(resolve => {
        let idleFrames = 0;
        const step = () => {
          if (renderSeq !== start) return resolve({ rendered: true, seq: renderSeq, timedOut: false });
          if (Date.now() > deadline) return resolve({ rendered: false, seq: renderSeq, timedOut: true });
          // Three quiet frames means no rebuild was scheduled at all, not that one is still coming.
          if (++idleFrames > 3) return resolve({ rendered: false, seq: renderSeq, timedOut: false });
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    },

    /** Rebuild errors the funnel's boundary swallowed into the status line. */
    errors() { return [...buildErrors]; },

    /**
     * What the editor's OWN picker resolves at a viewport point — i.e. what a click there would act on.
     * Answers "my click selected nothing, why?" directly instead of by inference: occluded, sub-pixel, a
     * hidden layer and a bare-terrain hit all look identical from the outside but differ here.
     *
     * Runs the same query Props mode runs. It re-seats the shared raycaster, which the app itself does on
     * every pointer event, and selects nothing — the read-only rule holds.
     */
    pickAt(x: number, y: number) {
      viewport.stage.castAt({ clientX: x, clientY: y });
      // Source icons are consulted FIRST, exactly as a Props/Info-mode click does — a deliberate icon
      // click wins even over nearer world geometry, and overlapping icons resolve nearest-along-ray.
      const sourceHit = viewport.scenePicking.pick({ sources: true }) as
        (Record<string, unknown> & { target?: string; hit?: THREE.Intersection }) | null;
      if (sourceHit?.target === 'source') {
        return {
          target: 'source', source: sourceHit.source,
          sourceKind: sourceHit.sourceKind, sourceIndex: sourceHit.sourceIndex,
          distance: sourceHit.hit ? fmt(sourceHit.hit.distance) : undefined,
        };
      }
      const p = viewport.scenePicking.pick({
        props: 'standard', lights: true, rails: true, gems: true, surfaces: true, surfaceEpsilon: 1e-3,
      }) as (Record<string, unknown> & { target?: string }) | null;
      if (!p) return null;
      const out: Record<string, unknown> = { target: p.target };
      for (const k of ['source', 'propIndex', 'lightIndex', 'railIndex', 'railNode', 'gemIndex', 'knotIndex']) {
        if (p[k] !== undefined) out[k] = p[k];
      }
      const hit = p.hit as THREE.Intersection | undefined;
      if (hit) out.distance = fmt(hit.distance);
      return out;
    },

    /**
     * Why the ground may not be addressable. Terrain anchors depend on the shared ground-pick mesh
     * (`stage.terrainMesh`) carrying real geometry; when it does not, placement fails silently for an agent
     * exactly as it would for a person clicking empty sky. Reports the mesh's state plus a centre-screen
     * test cast so the failure is legible instead of just "0 anchors".
     */
    diagnose() {
      const mesh = viewport.stage.terrainMesh;
      const posAttr = mesh?.geometry?.getAttribute('position');
      anchorRay.setFromCamera(new THREE.Vector2(0, 0), viewport.camera);
      return {
        terrainMesh: !!mesh,
        terrainVisible: mesh?.visible ?? null,
        terrainVerts: posAttr ? posAttr.count : 0,
        terrainInScene: mesh ? !!mesh.parent : null,
        centreHits: mesh ? anchorRay.intersectObject(mesh, false).length : -1,
        centreHitsRecursive: mesh ? anchorRay.intersectObject(mesh, true).length : -1,
        worldRootHits: anchorRay.intersectObject(viewport.stage.worldRoot, true).length,
        // What the sample sweep costs and finds — the two numbers that explain both "no anchors" and any
        // frame-time complaint about this layer.
        sampleSweep: mesh ? (() => {
          const t0 = performance.now();
          const found = collectAnchors(container.getBoundingClientRect()).length;
          return {
            anchors: found,
            samples: anchorSamples * anchorSamples,
            sweepMs: Math.round(performance.now() - t0),
            bvhBuildMs,
          };
        })() : null,
      };
    },

    /** Force a full re-sync including anchors and the reference mirror, bypassing the settle timer. */
    refresh() {
      sync();
      anchorsFresh = true;
      anchorSeq = renderSeq;
      lastCamSig = cameraSig();
      return { entities: entityProxies.size, anchors: anchorProxies.size, refEntities: refProxies.size };
    },

    /**
     * Tune the ground-anchor mirror: how many points to cast (`samples` x `samples`) and how many hits to
     * publish (`max`). Raise `samples` when a thin ribbon of terrain keeps falling between casts; raise
     * `max` for finer placement, lower it when anchors are burying the UI controls in the tree. Tunes the
     * LAYER, never the document — the read-only rule still holds.
     */
    setAnchors(opts: { samples?: number; max?: number }) {
      if (opts.samples !== undefined) anchorSamples = Math.max(0, Math.min(32, Math.floor(opts.samples)));
      if (opts.max !== undefined) maxAnchors = Math.max(0, Math.min(64, Math.floor(opts.max)));
      syncAnchors();
      anchorsFresh = true;
      return { samples: anchorSamples, max: maxAnchors, anchors: anchorProxies.size };
    },
  };

  (window as unknown as Record<string, unknown>).slopesmith = api;

  return {
    onRendered() { renderSeq++; },
    onBuildError(e: unknown) { buildErrors.push({ at: Date.now(), message: String(e) }); },
    dispose() {
      cancelAnimationFrame(raf);
      host.remove();
      entityProxies.clear();
      anchorProxies.clear();
      refProxies.clear();
      delete (window as unknown as Record<string, unknown>).slopesmith;
    },
  };
}
