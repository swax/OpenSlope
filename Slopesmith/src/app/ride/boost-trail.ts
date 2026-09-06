import * as THREE from 'three';
import type { RideGear } from './gear';

/**
 * The retail boost visual is not a PARTICLE.SSH emitter. `BoarderRender_Update` samples four board-space points
 * into a seven-entry ring every third 60 Hz game tick, and the render pass joins each pair into two translucent
 * sheets. The ring loses one entry on the same cadence after boost ends. See [Trailmap: 360-boost-trail].
 *
 * Keep this renderer independent of snow/contact state: retail keys it from the boost request, and Slopesmith's
 * board-pointed air boost should leave the same board-attached signature as its grounded boost.
 */

export interface BoardBoostTrailFrame {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  velocity: THREE.Vector3;
  /** Direction of force. When present, exhaust always starts from the opposite deck end. */
  thrustDirection?: THREE.Vector3;
  active: boolean;
  /** Run-scoped boost energy. Outside a scored run the unlimited boost passes 1. */
  energy: number;
  /** A speed-pad request selects retail's strongest red without consulting the meter. */
  pad: boolean;
  gear: RideGear;
}

const SAMPLE_SECONDS = 3 / 60;
const MAX_SAMPLES = 7;
const STREAKS = 2;
const VERTICES_PER_QUAD = 6;
const MAX_VERTICES = MAX_SAMPLES * STREAKS * VERTICES_PER_QUAD;

// Exact RGB triples and meter-third thresholds implement the board-afterimage colour contract
// [Trailmap: 360-boost-trail]; a pad bypasses the meter and selects red.
const BOOST_YELLOW = new THREE.Color(1, 0.964453, 0);
const BOOST_ORANGE = new THREE.Color(1, 0.4746, 0);
const BOOST_RED = new THREE.Color(1, 0.0758, 0.002);

export function retailBoostTrailColour(energy: number, pad = false, out = new THREE.Color()): THREE.Color {
  const source = pad || energy > 0.66648 ? BOOST_RED : energy > 0.33363 ? BOOST_ORANGE : BOOST_YELLOW;
  return out.copy(source);
}

interface TrailSample {
  /** Four points: outer/inner left streak, then inner/outer right streak. */
  points: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
}

function trailMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: `
      attribute vec4 trailColour;
      varying vec4 vTrailColour;
      void main() {
        vTrailColour = trailColour;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec4 vTrailColour;
      void main() {
        if (vTrailColour.a <= 0.001) discard;
        gl_FragColor = vTrailColour;
      }
    `,
  });
}

/** The reusable, contact-independent board boost afterimage. */
export class BoardBoostTrail {
  readonly mesh: THREE.Mesh;

  private readonly geometry = new THREE.BufferGeometry();
  private readonly positions = new Float32Array(MAX_VERTICES * 3);
  private readonly colours = new Float32Array(MAX_VERTICES * 4);
  private readonly samples: TrailSample[] = [];
  private readonly current = this.makeSample();
  private readonly tint = BOOST_RED.clone();
  private readonly forward = new THREE.Vector3();
  private readonly local = new THREE.Vector3();
  private sampleCarry = 0;
  private travelSign = 1;
  private lastGear: RideGear | null = null;

  constructor() {
    this.geometry.setAttribute('position',
      new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('trailColour',
      new THREE.BufferAttribute(this.colours, 4).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(this.geometry, trailMaterial());
    this.mesh.name = 'PlayerBoardBoostTrail';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  update(frame: BoardBoostTrailFrame, dt: number) {
    if (!(dt > 0)) return;
    const h = Math.min(dt, 0.1);
    if (this.lastGear !== null && frame.gear !== this.lastGear) this.clear();
    this.lastGear = frame.gear;

    this.forward.set(0, 0, 1).applyQuaternion(frame.quaternion);
    const along = (frame.thrustDirection ?? frame.velocity).dot(this.forward);
    if (Math.abs(along) > 0.25) this.travelSign = along >= 0 ? 1 : -1;
    this.capture(frame, this.current);
    if (frame.active) retailBoostTrailColour(frame.energy, frame.pad, this.tint);

    // Retail uses the global frame modulo rather than an engage-relative timer. Advancing this clock while idle
    // preserves that property: a press can wait anywhere from zero to 50 ms for its first cached sample.
    this.sampleCarry += h;
    let sampleTicks = Math.min(4, Math.floor((this.sampleCarry + 1e-9) / SAMPLE_SECONDS));
    this.sampleCarry -= sampleTicks * SAMPLE_SECONDS;
    while (sampleTicks-- > 0) {
      if (frame.active) {
        if (this.samples.length >= MAX_SAMPLES) this.samples.shift();
        const sample = this.makeSample();
        this.copySample(this.current, sample);
        this.samples.push(sample);
      } else if (this.samples.length) {
        // The draw walks backward from the newest ring head, so reducing count discards the oldest extent.
        this.samples.shift();
      }
    }
    this.rebuild();
  }

  clear() {
    this.samples.length = 0;
    this.geometry.setDrawRange(0, 0);
    this.lastGear = null;
  }

  dispose() {
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }

  /** Headless regression seam; production only reads the generated geometry. */
  stats() {
    return { samples: this.samples.length, vertices: this.geometry.drawRange.count };
  }

  private makeSample(): TrailSample {
    return { points: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] };
  }

  private copySample(from: TrailSample, to: TrailSample) {
    for (let i = 0; i < 4; i++) to.points[i].copy(from.points[i]);
  }

  private capture(frame: BoardBoostTrailFrame, out: TrailSample) {
    const snowboard = frame.gear === 'snowboard';
    // Slopesmith gear's real outline: 1.86 m snowboard, or the asymmetric 1.104/0.936 m ski extents.
    const tailZ = snowboard ? -0.93 * this.travelSign : this.travelSign > 0 ? -0.936 : 1.104;
    const centreX = snowboard ? 0.174 : 0.105;
    const halfStreak = snowboard ? 0.030 : 0.043;
    const y = snowboard ? 0.012 : 0.011;
    const xs = [-centreX - halfStreak, -centreX + halfStreak, centreX - halfStreak, centreX + halfStreak];
    for (let i = 0; i < 4; i++) {
      this.local.set(xs[i], y, tailZ).applyQuaternion(frame.quaternion).add(frame.position);
      out.points[i].copy(this.local);
    }
  }

  private rebuild() {
    // The native render pass waits for two cached records. This avoids flashing one isolated quad on engage.
    if (this.samples.length < 2) { this.geometry.setDrawRange(0, 0); return; }
    let vertex = 0;
    const denominator = this.samples.length + 1;
    for (let segment = 0; segment < this.samples.length; segment++) {
      const older = this.samples[segment];
      const newer = segment + 1 < this.samples.length ? this.samples[segment + 1] : this.current;
      const olderAlpha = 0.04 + 0.56 * Math.pow((segment + 1) / denominator, 1.55);
      const newerAlpha = 0.04 + 0.56 * Math.pow((segment + 2) / denominator, 1.55);
      vertex = this.writeQuad(vertex, older.points[0], older.points[1], newer.points[1], newer.points[0],
        olderAlpha, newerAlpha);
      vertex = this.writeQuad(vertex, older.points[2], older.points[3], newer.points[3], newer.points[2],
        olderAlpha, newerAlpha);
    }
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('trailColour') as THREE.BufferAttribute).needsUpdate = true;
    this.geometry.setDrawRange(0, vertex);
  }

  private writeQuad(start: number, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3,
                    olderAlpha: number, newerAlpha: number): number {
    let vertex = start;
    vertex = this.writeVertex(vertex, a, olderAlpha);
    vertex = this.writeVertex(vertex, b, olderAlpha);
    vertex = this.writeVertex(vertex, c, newerAlpha);
    vertex = this.writeVertex(vertex, a, olderAlpha);
    vertex = this.writeVertex(vertex, c, newerAlpha);
    vertex = this.writeVertex(vertex, d, newerAlpha);
    return vertex;
  }

  private writeVertex(vertex: number, point: THREE.Vector3, alpha: number): number {
    const pi = vertex * 3, ci = vertex * 4;
    this.positions[pi] = point.x; this.positions[pi + 1] = point.y; this.positions[pi + 2] = point.z;
    this.colours[ci] = this.tint.r; this.colours[ci + 1] = this.tint.g; this.colours[ci + 2] = this.tint.b;
    this.colours[ci + 3] = alpha;
    return vertex + 1;
  }
}
