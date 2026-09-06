import * as THREE from 'three';
import type { RigLight } from '../../../core/reference/lights';

// ---- reference light-rig gizmos (built into flat line arrays; see setReferenceLights) --------------

/** Push one line segment (two endpoints) in the current colour into a position + colour array pair. */
type LineSink = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => void;

/** A short 3-axis tick at a point, so even a distant light still reads as a source dot. */
function addSourceTick(seg: LineSink, x: number, y: number, z: number, s: number) {
  seg(x - s, y, z, x + s, y, z);
  seg(x, y - s, z, x, y + s, z);
  seg(x, y, z - s, x, y, z + s);
}

/** A circle of `n` segments centred at (cx,cy,cz), radius r, in the plane spanned by basis vectors u, w. */
function addRing(seg: LineSink, cx: number, cy: number, cz: number, r: number, u: THREE.Vector3, w: THREE.Vector3, n: number) {
  let px = 0, py = 0, pz = 0;
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2, c = Math.cos(t) * r, s = Math.sin(t) * r;
    const x = cx + u.x * c + w.x * s, y = cy + u.y * c + w.y * s, z = cz + u.z * c + w.z * s;
    if (i) seg(px, py, pz, x, y, z);
    px = x; py = y; pz = z;
  }
}

const _lu = new THREE.Vector3(), _lw = new THREE.Vector3(), _ld = new THREE.Vector3();

type AimedLight = Pick<RigLight, 'kind' | 'pos' | 'dir' | 'reach'>;

/** The exact centre point used by the expanded cone/arrow. Source icons project this same target so their
 * screen-space orientation agrees with the visible rig rather than approximating it from a raw vector. */
export function lightAimTarget(L: AimedLight): THREE.Vector3 {
  const direction = new THREE.Vector3(...L.dir);
  if (direction.lengthSq() < 1e-9) return new THREE.Vector3(...L.pos);
  direction.normalize();
  const distance = L.kind === 'sun'
    ? Math.min(Math.max(L.reach, 120), 500)
    : Math.min(Math.max(L.reach, 8), 80);
  return new THREE.Vector3(...L.pos).addScaledVector(direction, distance);
}

/** Draw a POSITIVE light's gizmo into the line arrays (native editor space): a source tick plus a spot cone
 *  along its aim, a point wire sphere, or the sun as a long arrow — coloured by the light's own hue. */
export function addLightGizmo(pos: number[], colArr: number[], L: RigLight, col: THREE.Color) {
  col.set(L.colorHex);
  const [px, py, pz] = L.pos;
  const seg: LineSink = (ax, ay, az, bx, by, bz) => {
    pos.push(ax, ay, az, bx, by, bz);
    colArr.push(col.r, col.g, col.b, col.r, col.g, col.b);
  };
  addSourceTick(seg, px, py, pz, 3);

  const d = _ld.set(L.dir[0], L.dir[1], L.dir[2]);
  if (d.lengthSq() < 1e-9) return;
  d.normalize();
  // a basis (u, w) perpendicular to the aim, for the cone base ring / point rings
  const up = Math.abs(d.y) > 0.9 ? _lu.set(1, 0, 0) : _lu.set(0, 1, 0);
  const u = _lu.crossVectors(d, up).normalize();
  const w = _lw.crossVectors(d, u).normalize();

  if (L.kind === 'point') {
    const r = Math.min(Math.max(L.reach * 0.15, 3), 25);
    addRing(seg, px, py, pz, r, u, w, 14);
    addRing(seg, px, py, pz, r, u, d, 14);
    addRing(seg, px, py, pz, r, w, d, 14);
    return;
  }

  const isSun = L.kind === 'sun';
  const target = lightAimTarget(L);
  const h = target.distanceTo(new THREE.Vector3(px, py, pz));
  const bx = target.x, by = target.y, bz = target.z; // aim endpoint (cone base centre)
  seg(px, py, pz, bx, by, bz); // the beam axis
  if (isSun) { // a plain arrowhead — the directional sun has no cone
    const a = Math.max(h * 0.06, 6);
    seg(bx, by, bz, bx - d.x * a + u.x * a * 0.5, by - d.y * a + u.y * a * 0.5, bz - d.z * a + u.z * a * 0.5);
    seg(bx, by, bz, bx - d.x * a - u.x * a * 0.5, by - d.y * a - u.y * a * 0.5, bz - d.z * a - u.z * a * 0.5);
    return;
  }
  // spot: a cone — base ring + four slant lines from the apex
  const half = Math.acos(Math.max(-1, Math.min(1, L.coneCos)));
  const r = Math.tan(half) * h;
  addRing(seg, bx, by, bz, r, u, w, 16);
  for (let k = 0; k < 4; k++) {
    const t = (k / 4) * Math.PI * 2, cc = Math.cos(t) * r, ss = Math.sin(t) * r;
    seg(px, py, pz, bx + u.x * cc + w.x * ss, by + u.y * cc + w.y * ss, bz + u.z * cc + w.z * ss);
  }
}

/** Draw a SUBTRACTIVE (shadow) light as a small, faint marker — just a source tick so the shadow pins read
 *  without the dense cones the hundreds of them would otherwise smear across the terrain. */
export function addLightMarker(pos: number[], colArr: number[], L: RigLight, col: THREE.Color) {
  col.set(L.colorHex);
  const [px, py, pz] = L.pos;
  const seg: LineSink = (ax, ay, az, bx, by, bz) => {
    pos.push(ax, ay, az, bx, by, bz);
    colArr.push(col.r, col.g, col.b, col.r, col.g, col.b);
  };
  addSourceTick(seg, px, py, pz, Math.min(Math.max(L.reach * 0.08, 3), 12));
}

/** A 64px canvas reticle — a small white centre dot ringed in black — for the navigation pivot sprite. */
export function makeReticleTexture(): THREE.CanvasTexture {
  const S = 64, c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d')!;
  const m = S / 2;
  x.lineWidth = 5; x.strokeStyle = '#000';        // black ring around the dot
  x.beginPath(); x.arc(m, m, 22, 0, Math.PI * 2); x.stroke();
  x.beginPath(); x.arc(m, m, 8, 0, Math.PI * 2);  // white centre dot with a crisp black edge
  x.fillStyle = '#fff'; x.fill();
  x.lineWidth = 2; x.strokeStyle = '#000'; x.stroke();
  const t = new THREE.CanvasTexture(c);
  t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; // keep the small reticle sharp
  return t;
}
