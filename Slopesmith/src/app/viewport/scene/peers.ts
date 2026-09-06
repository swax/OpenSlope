import * as THREE from 'three';
import type { QuadMeshDoc } from '../../../core/doc/types';
import { nameIndex } from '../../../core/doc/ids';
import { readVertex } from '../../../core/mesh/primitives';
import type { Stage } from '../stage';
import type { PlayerPose } from '../../../core/session/player-pose';

/**
 * Everybody else, on the mountain (docs/039).
 *
 * Free-for-all editing works in practice because people can see each other. Live selections in each
 * participant's colour and a soft highlight on whatever somebody is actively holding avoid nearly every
 * collision socially. A cursor is added only for the screen sharer this client is actively observing.
 *
 * Three marks, in one colour per participant:
 *
 * - an observed sharer's **cursor** — a ring where their pointer meets the terrain, with their name beside it;
 * - **selection** — a dot on each corner and an outline round each face they have picked, drawn thin, the way
 *   your own selection is drawn bold;
 * - a **drag highlight** — the same corners fatter and half transparent while they are holding them, which is
 *   the whole of the "hands off for a second" signal.
 *
 * Everything here is named by stable id and resolved against the live document on every rebuild, so a peer's
 * selection stays on the terrain it named across a topology edit, and a name the mesh no longer carries simply
 * stops being drawn.
 *
 * It parents under `worldRoot`, which supplies the game-chirality Z flip, because none of it is interactive:
 * no gizmo ever attaches to a peer's mark, so nothing here has to avoid a negative-scale parent.
 */

/** One participant, as this layer draws them. */
export interface PeerMarks {
  sessionId: string;
  userId: string;
  username: string;
  color: string;
  snowboardTextureUrl?: string;
  skiTextureUrl?: string;
  equipmentEdgeColor?: string;
  cursor: [number, number, number] | null;
  vertices: string[];
  quads: string[];
  dragging: string[];
  player: PlayerPose | null;
}

const CURSOR_RADIUS = 1.4;
const POINT_RADIUS = 0.5;
const DRAG_RADIUS = 1.1;
const LIFT = 0.35;

export function createPeersLayer(stage: Stage) {
  const group = new THREE.Group();
  group.name = 'peers';
  stage.worldRoot.add(group);

  const pointGeo = new THREE.SphereGeometry(POINT_RADIUS, 8, 6);
  const dragGeo = new THREE.SphereGeometry(DRAG_RADIUS, 10, 8);
  const ringGeo = new THREE.RingGeometry(CURSOR_RADIUS * 0.62, CURSOR_RADIUS, 20);
  const materials = new Map<string, { solid: THREE.Material; soft: THREE.Material }>();
  const labels = new Map<string, THREE.Sprite>();
  let visible = true;
  let peers: PeerMarks[] = [];
  let doc: QuadMeshDoc | null = null;

  /** One material pair per colour, kept rather than rebuilt: a participant's colour does not change, and a
   *  cursor moving at pointer rate must not allocate. */
  function paint(color: string): { solid: THREE.Material; soft: THREE.Material } {
    const held = materials.get(color);
    if (held) return held;
    const made = {
      solid: new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }),
      soft: new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.35 }),
    };
    materials.set(color, made);
    return made;
  }

  /** A billboard name, baked once per participant. */
  function label(peer: PeerMarks): THREE.Sprite {
    const held = labels.get(peer.sessionId);
    if (held) return held;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.font = 'bold 34px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 7;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(peer.username, 8, 32);
    ctx.fillStyle = peer.color;
    ctx.fillText(peer.username, 8, 32);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(canvas), depthTest: false, transparent: true,
    }));
    sprite.scale.set(14, 3.5, 1);
    sprite.center.set(0, 0.5);
    labels.set(peer.sessionId, sprite);
    return sprite;
  }

  function clear(): void {
    for (const child of [...group.children]) {
      group.remove(child);
      if (child instanceof THREE.Mesh) child.geometry.dispose?.();
    }
  }

  /** Where a named corner is, or nothing when this mesh no longer carries the name. */
  function cornerAt(name: string): [number, number, number] | null {
    if (!doc) return null;
    const at = nameIndex(doc.vertexIds).get(name);
    return at === undefined ? null : readVertex(doc.vertices, at);
  }

  function place(mesh: THREE.Object3D, point: readonly [number, number, number]): void {
    mesh.position.set(point[0], point[1] + LIFT, point[2]);
  }

  function rebuild(): void {
    clear();
    if (!visible || !doc) return;
    for (const peer of peers) {
      const colors = paint(peer.color);
      const dragging = new Set(peer.dragging);
      for (const name of peer.vertices) {
        const point = cornerAt(name);
        if (!point) continue;
        const mesh = new THREE.Mesh(dragging.has(name) ? dragGeo : pointGeo,
          dragging.has(name) ? colors.soft : colors.solid);
        place(mesh, point);
        mesh.renderOrder = 6;
        group.add(mesh);
      }
      // A face somebody is holding is shown by its corners rather than by a filled patch: the fill would sit
      // on top of the paint everybody is trying to look at. A face still being written — the tiles of a live
      // paint stroke — fattens the same way a held corner does.
      for (const name of peer.quads) {
        const at = doc.quadIds.indexOf(name);
        if (at < 0) continue;
        for (const corner of doc.quads[at] ?? []) {
          const point = readVertex(doc.vertices, corner);
          const mesh = new THREE.Mesh(dragging.has(name) ? dragGeo : pointGeo, colors.soft);
          place(mesh, point);
          mesh.renderOrder = 6;
          group.add(mesh);
        }
      }
      if (peer.cursor) {
        const ring = new THREE.Mesh(ringGeo, colors.solid);
        ring.rotation.x = -Math.PI / 2;
        place(ring, peer.cursor);
        ring.renderOrder = 7;
        group.add(ring);
        const name = label(peer);
        name.position.set(peer.cursor[0] + CURSOR_RADIUS, peer.cursor[1] + LIFT + 2, peer.cursor[2]);
        name.renderOrder = 8;
        group.add(name);
      }
    }
  }

  return {
    /** Who is here and what they are touching. Replaces the whole set, because presence is pushed whole. */
    setPeers(next: readonly PeerMarks[]): void {
      peers = [...next];
      rebuild();
    },
    /** The document their names resolve against — re-set on every rebuild, so a topology edit moves the
     *  marks with the geometry rather than leaving them where the indices used to be. */
    setDocument(next: QuadMeshDoc | null): void {
      doc = next;
      rebuild();
    },
    setVisible(on: boolean): void {
      if (visible === on) return;
      visible = on;
      group.visible = on;
      rebuild();
    },
    dispose(): void {
      clear();
      stage.worldRoot.remove(group);
      for (const sprite of labels.values()) sprite.material.map?.dispose();
      labels.clear();
      for (const pair of materials.values()) { pair.solid.dispose(); pair.soft.dispose(); }
      materials.clear();
      pointGeo.dispose();
      dragGeo.dispose();
      ringGeo.dispose();
    },
  };
}

export type PeersLayer = ReturnType<typeof createPeersLayer>;
