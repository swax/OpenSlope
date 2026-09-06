/**
 * The HATEOAS authoring demo (docs/052): an "agent" that builds a complete demo mountain knowing nothing but
 * a server address — `npx tsx scripts/hateoas-demo.ts [baseUrl]`, with `SLOPESMITH_API_KEY` for a server
 * with accounts. Every URL it touches after `/api` comes out of a response's `_links` / `_actions` /
 * `_actionTemplates`, exactly the way a remote AI agent is meant to consume the surface.
 *
 * What it authors, in one pass: a renamed default mountain with a sculpted kicker and a bermed corridor,
 * surface paint and an uploaded custom tile, a widened/banked course with a showoff checkpoint, borrowed
 * reference props (with an uploaded hit sound on one), a grind rail, a gem line, coloured lights, a low sun,
 * a borrowed level sky, a semantic label, and a collision speed-boost effect on an invisible trigger volume —
 * then takes a named checkpoint. Read it top to bottom as a worked example of the guide at /api/guide.
 */

import { createCanvas } from '@napi-rs/canvas';

type Json = Record<string, unknown>;
interface Link { rel: string; href: string }
interface Action extends Link { method: string; disabled?: boolean; disabledReason?: string }
interface ActionTemplate { rel: string; hrefTemplate: string; method: string }
interface LinkTemplate { rel: string; hrefTemplate: string }
interface Envelope {
  _links?: Link[]; _actions?: Action[]; _actionTemplates?: ActionTemplate[]; _linkTemplates?: LinkTemplate[];
  [key: string]: unknown;
}

const BASE = (process.argv[2] ?? process.env.SLOPESMITH_URL ?? 'http://127.0.0.1:5180').replace(/\/+$/, '');
const KEY = process.env.SLOPESMITH_API_KEY;

async function call(href: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (KEY) headers.set('authorization', `Bearer ${KEY}`);
  const response = await fetch(`${BASE}${href}`, { ...init, headers });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${init.method ?? 'GET'} ${href} → ${response.status}: ${body.slice(0, 400)}`);
  }
  return response;
}

const getJson = async (href: string): Promise<Envelope> => await (await call(href)).json();

async function sendJson(action: Action, body: unknown): Promise<Envelope> {
  if (action.disabled) throw new Error(`${action.rel} is disabled: ${action.disabledReason}`);
  return await (await call(action.href, {
    method: action.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json();
}

async function sendBytes(href: string, method: string, bytes: Uint8Array): Promise<Envelope> {
  return await (await call(href, {
    method, headers: { 'content-type': 'application/octet-stream' }, body: bytes as unknown as BodyInit,
  })).json();
}

const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`The server did not offer ${what} — is it running this build?`);
  return value;
};
const rel = (env: Envelope, name: string): string =>
  need(env._links?.find(held => held.rel === name), `link "${name}"`).href;
const act = (env: Envelope, name: string): Action =>
  need(env._actions?.find(held => held.rel === name), `action "${name}"`);
const fill = (env: Envelope, name: string, vars: Record<string, string>): { href: string; method: string } => {
  const template = need(env._actionTemplates?.find(held => held.rel === name), `action template "${name}"`);
  return {
    href: template.hrefTemplate.replace(/\{(\w+)\}/g, (_, key: string) => encodeURIComponent(vars[key] ?? '')),
    method: template.method,
  };
};

// ---- geometry helpers (all client-side: the agent's own math over the document it fetched) ---------------

type V3 = [number, number, number];
const lerp = (a: V3, b: V3, t: number): V3 =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** A point at parameter t (0..1 by knot index) along the course spine, linearly interpolated. */
function spineAt(knots: { pos: V3 }[], t: number): V3 {
  const scaled = Math.min(Math.max(t, 0), 1) * (knots.length - 1);
  const at = Math.min(Math.floor(scaled), knots.length - 2);
  return lerp(knots[at].pos, knots[at + 1].pos, scaled - at);
}

/** Downhill direction of the spine near t, in the XZ plane, unit length. */
function spineDirAt(knots: { pos: V3 }[], t: number): [number, number] {
  const ahead = spineAt(knots, Math.min(t + 0.02, 1)), behind = spineAt(knots, Math.max(t - 0.02, 0));
  const dx = ahead[0] - behind[0], dz = ahead[2] - behind[2];
  const length = Math.hypot(dx, dz) || 1;
  return [dx / length, dz / length];
}

// ---- media the agent composes locally before uploading ---------------------------------------------------

function chevronTile(): Uint8Array {
  const canvas = createCanvas(256, 256);
  const g = canvas.getContext('2d');
  g.fillStyle = '#1c2b3a';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#ffb52e';
  g.lineWidth = 26;
  for (let offset = -256; offset <= 512; offset += 96) {
    g.beginPath();
    g.moveTo(offset - 64, 288);
    g.lineTo(offset + 128, 96);
    g.lineTo(offset + 320, 288);
    g.stroke();
  }
  return new Uint8Array(canvas.toBuffer('image/png'));
}

/** A short decaying chime as a minimal RIFF/WAVE PCM16 mono file. */
function chimeWav(): Uint8Array {
  const rate = 22050, seconds = 0.5, samples = Math.floor(rate * seconds);
  const data = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const wave = Math.sin(2 * Math.PI * 880 * t) * 0.6 + Math.sin(2 * Math.PI * 1320 * t) * 0.25;
    data[i] = Math.round(wave * Math.exp(-t * 6) * 32767 * 0.8);
  }
  const bytes = new Uint8Array(44 + data.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => { for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + data.length * 2, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, data.length * 2, true);
  bytes.set(new Uint8Array(data.buffer), 44);
  return bytes;
}

// ---- the walkthrough -------------------------------------------------------------------------------------

const changes: { key: string; value?: unknown }[] = [];
const set = (key: string, value: unknown) => changes.push({ key, value });

const root = await getJson('/api');
console.log(`agent: connected to ${BASE} as ${JSON.stringify(root.identity)}`);

const maps = await getJson(rel(root, 'maps'));
const created = await sendJson(act(maps, 'create'), {});
const project = created.project as { id: string; name: string };
const doc = created.document as {
  vertices: number[]; vertexIds: string[]; quads: number[][]; quadIds: string[];
  course: { knots: { pos: V3; width: number; wall: number; bank: number; shoulder: number;
    checkpointBonus?: number }[]; blend: number; surface: number };
};
console.log(`agent: created map ${project.name} (${project.id}) — `
  + `${doc.vertexIds.length} vertices, ${doc.quadIds.length} quads`);

const assign = act(created as Envelope, 'assignRegisters');
const knots = doc.course.knots;

// -- terrain: a kicker on the spine and berms flanking the corridor, as vertex-register math --------------
const kickerAt = spineAt(knots, 0.45);
const bermFrom = spineAt(knots, 0.55), bermTo = spineAt(knots, 0.8);
const moved = new Map<string, V3>();
for (let at = 0; at < doc.vertexIds.length; at++) {
  const x = doc.vertices[at * 3], y = doc.vertices[at * 3 + 1], z = doc.vertices[at * 3 + 2];
  let lift = 0;
  // The kicker: a smooth gaussian bump 8 m tall, 26 m across, just uphill of mid-course.
  const kicker = Math.hypot(x - kickerAt[0], z - kickerAt[2]);
  if (kicker < 60) lift += 8 * Math.exp(-(kicker * kicker) / (2 * 26 * 26));
  // The berms: raise the ground 45–130 m off the corridor segment, so the run reads as a gulch.
  const vx = bermTo[0] - bermFrom[0], vz = bermTo[2] - bermFrom[2];
  const t = Math.min(Math.max(((x - bermFrom[0]) * vx + (z - bermFrom[2]) * vz) / (vx * vx + vz * vz), 0), 1);
  const lateral = Math.hypot(x - (bermFrom[0] + vx * t), z - (bermFrom[2] + vz * t));
  if (lateral > 45 && lateral < 130) {
    const ramp = Math.sin(Math.PI * Math.min((lateral - 45) / 55, 1) / 2);
    const along = Math.sin(Math.PI * t);
    lift += 14 * ramp * along;
  }
  if (lift > 0.2) moved.set(doc.vertexIds[at], [x, y + lift, z]);
}
for (const [id, pos] of moved) set(`v/${id}`, pos);
console.log(`agent: sculpting ${moved.size} vertices (kicker + berms)`);

// -- paint: ice down the bermed corridor floor, powder up its walls ---------------------------------------
let iced = 0, powdered = 0;
for (let at = 0; at < doc.quadIds.length; at++) {
  const corners = doc.quads[at];
  const cx = corners.reduce((sum, v) => sum + doc.vertices[v * 3], 0) / 4;
  const cz = corners.reduce((sum, v) => sum + doc.vertices[v * 3 + 2], 0) / 4;
  const vx = bermTo[0] - bermFrom[0], vz = bermTo[2] - bermFrom[2];
  const t = ((cx - bermFrom[0]) * vx + (cz - bermFrom[2]) * vz) / (vx * vx + vz * vz);
  if (t < 0.05 || t > 0.95) continue;
  const lateral = Math.hypot(cx - (bermFrom[0] + vx * t), cz - (bermFrom[2] + vz * t));
  if (lateral < 45) { set(`q/${doc.quadIds[at]}/paint`, 5); iced++; }
  else if (lateral < 130) { set(`q/${doc.quadIds[at]}/paint`, 3); powdered++; }
}
console.log(`agent: painting ${iced} ice + ${powdered} powder faces along the corridor`);

// -- the run: widen the gate, bank the corridor, and pay a showoff bonus at the kicker --------------------
const course = structuredClone(doc.course);
course.knots[0].width = 220;
for (const [index, knot] of course.knots.entries()) {
  const t = index / (course.knots.length - 1);
  if (t > 0.5 && t < 0.85) { knot.wall = 10; knot.bank = 8; }
}
course.knots[Math.round(0.45 * (course.knots.length - 1))].checkpointBonus = 5;
set('course', course);

// -- mood: a late sun, a borrowed reference sky, three laps of showoff time -------------------------------
set('g/name', 'AGENT GULCH');
set('g/sun', {
  on: true, el: 14, az: 250, ambient: 0.34, sun: 1.0, shadow: 0.5, ao: 0.34,
  sunTint: '#ffd9a8', skyTint: '#a8c4e8', bakeExposure: 1,
});
set('g/showoffSeconds', 90);

const reference = await getJson(rel(created as Envelope, 'reference'));
const levels = (await getJson(rel(reference, 'levels'))).levels as string[];
const donor = levels.includes('GARI') ? 'GARI' : levels[0];
if (donor) set('g/skybox', { source: { kind: 'level', level: donor }, on: true });
console.log(`agent: sky borrowed from ${donor ?? 'nowhere — no extracted levels on this server'}`);

// -- a semantic label everything the agent places will carry ----------------------------------------------
set('o/label/label:0000', { id: 'label:0000', name: 'agent-built', color: '#ffb52e' });

// -- props: borrowed from the donor level's own catalogue -------------------------------------------------
const groundY = (x: number, z: number): number => {
  let best = Infinity, y = 0;
  for (let at = 0; at < doc.vertexIds.length; at++) {
    const d = Math.hypot(doc.vertices[at * 3] - x, doc.vertices[at * 3 + 2] - z);
    if (d < best) {
      best = d;
      y = moved.get(doc.vertexIds[at])?.[1] ?? doc.vertices[at * 3 + 1];
    }
  }
  return y;
};
let placed = 0;
if (donor) {
  const propsHref = need(reference._linkTemplates?.find(held => held.rel === 'level-props'),
    'link template "level-props"').hrefTemplate.replace('{level}', encodeURIComponent(donor));
  const payload = await getJson(propsHref);
  const models = payload.models as { id: number; name: string }[];
  const pick = (pattern: RegExp) => models.find(model => pattern.test(model.name));
  const wanted = [pick(/tree/i), pick(/flag|banner/i), pick(/rock|boulder/i)]
    .filter((model): model is { id: number; name: string } => !!model);
  for (const [index, model] of wanted.entries()) {
    const t = 0.3 + index * 0.18;
    const spot = spineAt(knots, t);
    const [dx, dz] = spineDirAt(knots, t);
    const side = index % 2 ? 1 : -1;
    const x = spot[0] - dz * side * 55, z = spot[2] + dx * side * 55;
    set(`o/prop/prop:a${index.toString().padStart(3, '0')}`, {
      level: donor, model: model.id, name: model.name, labels: ['label:0000'],
      pos: [x, groundY(x, z), z], yaw: (index * 137) % 360, scale: 1,
    });
    placed++;
  }
  console.log(`agent: placed ${placed} ${donor} props: ${wanted.map(model => model.name).join(', ')}`);
}

// -- tricks: a grind rail along the corridor rim and a gem line over the kicker ---------------------------
const railNodes: V3[] = [];
for (let step = 0; step <= 6; step++) {
  const t = 0.56 + step * 0.03;
  const spot = spineAt(knots, t);
  const [dx, dz] = spineDirAt(knots, t);
  railNodes.push([spot[0] - dz * 30, spot[1] + 1.2, spot[2] + dx * 30]);
}
set('o/rail/rail:0000', {
  id: 'rail:0000', nodes: railNodes, height: 1.2, style: 13, supports: true, name: 'gulch rail',
});
for (let step = 0; step < 8; step++) {
  const t = 0.4 + step * 0.02;
  const spot = spineAt(knots, t);
  const hop = Math.sin((step / 7) * Math.PI) * 6;
  set(`o/gem/gem:${step.toString().padStart(4, '0')}`, { pos: [spot[0], spot[1] + 2 + hop, spot[2]] });
}

// -- lights: a warm and a cool marker at the kicker, the warm one glinting --------------------------------
const kdir = spineDirAt(knots, 0.45);
set('o/light/light:0000', {
  kind: 'point', pos: [kickerAt[0] - kdir[1] * 20, kickerAt[1] + 9, kickerAt[2] + kdir[0] * 20],
  color: '#ff9040', intensity: 2.2, reach: 55, name: 'kicker beacon', glint: 32,
});
set('o/light/light:0001', {
  kind: 'spot', pos: [kickerAt[0] + kdir[1] * 24, kickerAt[1] + 14, kickerAt[2] - kdir[0] * 24],
  dir: [0, -1, 0], color: '#40c8ff', intensity: 1.6, reach: 70, cone: 40, name: 'landing wash',
});

// -- an effect, through registers alone: a speed-boost pad on an invisible trigger over the kicker lip ----
set('o/prop/prop:boostpad', {
  level: '@effects', model: 0, name: 'kicker boost', labels: ['label:0000'],
  pos: [kickerAt[0], kickerAt[1] + 3, kickerAt[2]], yaw: 0, scale: 1,
  effectTrigger: { size: [26, 8, 26] },
});
set('o/effect/document', {
  $schema: 'openslope-effects-v1.schema.json', kind: 'openslope-effects', version: 1,
  target: { game: 'ssx-tricky', platform: 'ps2', region: 'pal', level: 'AGENT GULCH' },
  header: { U1: 1966592, U2: 1053952, U3: 0.006 },
  extensions: { slopesmith: { attachments: [{
    id: 'attachment:0000', target: { kind: 'prop', id: 'prop:boostpad' },
    slot: 'slot:0000', circumstance: 'collision', enabled: true,
  }] } },
});
set('o/effect/graphs/graph:0000', { id: 'graph:0000', name: 'Kicker speed boost' });
set('o/effect-node/graphs/graph:0000/graph:0000/node:0000', {
  id: 'graph:0000/node:0000', mainType: 17, semanticType: 'rider.boost',
  payload: { type17: 5 }, references: {},
});
set('o/effect/slots/slot:0000', {
  id: 'slot:0000', name: 'Kicker speed boost slot',
  circumstances: { persistent: null, collision: 'graph:0000', slot3: null, slot4: null,
    trigger: null, slot6: null, slot7: null },
});

// -- send the whole authored pass as one register batch ---------------------------------------------------
const outcome = await sendJson(assign, { changes });
console.log(`agent: assigned ${changes.length} registers → landed ${outcome.landed}, `
  + `retired ${outcome.retired}, refused ${outcome.refused}`
  + (outcome.refused ? ` (${JSON.stringify(outcome.refusedKeys)})` : ''));
if (outcome.refused) process.exitCode = 1;

// -- uploads: a chevron tile painted at the start gate, and a chime on the first prop ---------------------
const projectPage = await getJson(rel(created as Envelope, 'self'));
const tileUpload = fill(projectPage, 'uploadTexture', { stem: 'agent-chevrons' });
const tile = await sendBytes(tileUpload.href, tileUpload.method, chevronTile());
const gate = spineAt(knots, 0.02);
const gateQuads: { key: string; value?: unknown }[] = [];
for (let at = 0; at < doc.quadIds.length; at++) {
  const corners = doc.quads[at];
  const cx = corners.reduce((sum, v) => sum + doc.vertices[v * 3], 0) / 4;
  const cz = corners.reduce((sum, v) => sum + doc.vertices[v * 3 + 2], 0) / 4;
  if (Math.hypot(cx - gate[0], cz - gate[2]) < 80) {
    gateQuads.push({ key: `q/${doc.quadIds[at]}/tex`, value: `Custom/${tile.name}` });
  }
}
if (placed) {
  const chimeUpload = fill(projectPage, 'uploadSound', { stem: 'agent-chime' });
  const chime = await sendBytes(chimeUpload.href, chimeUpload.method, chimeWav());
  const first = (await getJson(rel(projectPage, 'registers') + '?keys=o/prop/prop:a000'))
    .registers as [string, Json][];
  if (first.length) {
    gateQuads.push({ key: 'o/prop/prop:a000', value: { ...first[0][1], collisionSoundFile: chime.name } });
  }
}
const decorated = await sendJson(act(projectPage, 'assignRegisters'), { changes: gateQuads });
console.log(`agent: uploaded ${tile.name}${placed ? ' + agent-chime.wav' : ''}; `
  + `textured ${decorated.landed} more registers at the gate`);

// -- set the finished pass down in history ----------------------------------------------------------------
await sendJson(act(projectPage, 'checkpoint'), { note: 'Authored end-to-end by the HATEOAS demo agent' });
const final = await getJson(rel(created as Envelope, 'self'));
const manifest = final.project as { name: string; revision: number };
console.log(`agent: done — ${manifest.name} is at revision ${manifest.revision}. `
  + 'Open it in the editor, or GET its download link for the portable bundle.');
