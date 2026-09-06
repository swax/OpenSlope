import { fetchJson, postJson } from '../net/fetch-json';
import { modal } from '../ui/components/modal';
import { installStyles } from '../ui/components/styles';
import type { PortalKind } from '../../core/blender/portal';

/**
 * The editor's end of the Blender bridge (docs/046).
 *
 * Most of the round trip does not need the browser at all: the addon pulls and pushes over HTTP, and an
 * IMPORTED prop's push-back is written straight to its record, so the tab only has to refetch a catalogue it
 * already refetches on every custom-library change. This module exists for the two halves that cannot work
 * that way, and both are the same half: they touch the open DOCUMENT. An authored model's cage lives there,
 * and so do the painted cells and model tiles that have to follow a repainted texture's ref onto its new name.
 *
 * Applying them here rather than on the server is the point. A model that came back from Blender wrong is one
 * Ctrl+Z from being the model it was, the change rides the same history and persistence every other edit
 * does, and no route has to learn how to write a document.
 */

/** One authored model's geometry, waiting to be applied. Already reduced to the two channels a model record
 *  stores, so nothing about the wire format reaches the document layer. */
export interface PendingCage {
  token: string;
  at: number;
  kind: 'model';
  id: number;
  name: string;
  cage: {
    /** World metres, flat xyz. */
    vertices: number[];
    quads: [number, number, number, number][];
    /** N-gons the artist made that had to be split to fit the cage. */
    fanned: number;
    /** Loops with fewer than three distinct corners, dropped rather than baked as degenerate quads. */
    dropped: number;
  };
  /** The tile the model must now wear, when art came back with the geometry. */
  texture?: string;
}

/** A Custom tile got new art, so its ref moved and the document has to follow. The bank and the imported
 *  records were already written server-side; this is the half that lives in the open document — painted
 *  cells and the tiles authored models wear (docs/038). */
export interface PendingRetex {
  token: string;
  at: number;
  kind: 'retex';
  from: string;
  to: string;
}

export type PendingBlenderPush = PendingCage | PendingRetex;

/** How a tab reports what it did with one pending push, so the caller can toast it once for a batch. */
export type AppliedPush =
  | { kind: 'model'; name: string; quads: number; fanned: number; dropped: number; retextured: boolean }
  | { kind: 'retex'; from: string; to: string };

/** The GLB of one model — the file for a tool that is not the addon. Served with a `content-disposition`, so
 *  following it in a new tab downloads rather than navigating away from an editor with unsaved work. */
export const blenderGlbUrl = (kind: PortalKind, id: number): string =>
  `/api/blender/mesh.glb?kind=${kind}&id=${id}`;

/** Ask the browser to save a model's GLB. An anchor rather than `window.open`: a popup blocker treats the
 *  second as a popup, and a download that silently does not happen is the worst of the three outcomes. */
export function downloadBlenderGlb(kind: PortalKind, id: number, name: string): void {
  const link = document.createElement('a');
  link.href = blenderGlbUrl(kind, id);
  link.download = `${name.replace(/[^\w.-]+/g, '_') || 'model'}.glb`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/**
 * Apply every authored-model push waiting for this mountain.
 *
 * Called off the custom-library change the push itself announced, so the loop closes without the editor
 * polling for something that almost never happens. `write` is the document edit — it returns false when the
 * model is gone (deleted while the artist was in Blender), which is not an error: the push is acknowledged
 * either way, because leaving it in the inbox would replay it on every subsequent library change forever.
 */
export async function drainBlenderPushes(
  write: (push: PendingBlenderPush) => boolean,
): Promise<AppliedPush[]> {
  let pushes: PendingBlenderPush[];
  try {
    pushes = (await fetchJson<{ pushes?: PendingBlenderPush[] }>('/api/blender/pending')).pushes ?? [];
  } catch {
    // A mountain with no bridge folder, a server that does not speak this route, an editor without an open
    // project: none of those are worth a toast on a library change the author did not ask about.
    return [];
  }
  const applied: AppliedPush[] = [];
  for (const push of pushes) {
    if (!push?.token) continue;
    if (push.kind === 'retex') {
      if (!push.from || !push.to) continue;
      if (write(push)) applied.push({ kind: 'retex', from: push.from, to: push.to });
    } else if (push.kind === 'model' && Array.isArray(push.cage?.quads)) {
      if (write(push)) {
        applied.push({
          kind: 'model', name: push.name, quads: push.cage.quads.length,
          fanned: push.cage.fanned ?? 0, dropped: push.cage.dropped ?? 0, retextured: !!push.texture,
        });
      }
    } else continue;
    try { await postJson(`/api/blender/ack?token=${encodeURIComponent(push.token)}`); }
    catch { /* the next drain will find it again, which is the safe way round */ }
  }
  return applied;
}

// ---- the guide -------------------------------------------------------------------------------------------

const guideCss = `
.sp-bguide { width: 430px; box-sizing: border-box; padding: 14px 16px 12px; color: #d7e3f0;
  background: #0c141d; border: 1px solid #2c3e50; border-radius: 7px;
  font: 12px/1.5 system-ui, sans-serif; box-shadow: 0 12px 40px #0009; }
.sp-bguide h3 { margin: 0 0 2px; color: #cfe3f5; font: 600 13px system-ui, sans-serif; }
.sp-bguide .sub { color: #7f97ac; margin: 0 0 10px; }
.sp-bguide ol { margin: 0; padding-left: 18px; }
.sp-bguide li { margin: 0 0 7px; }
.sp-bguide code { background: #0e1822; border: 1px solid #23364a; border-radius: 3px; padding: 1px 4px;
  font: 11px/1.4 ui-monospace, Consolas, monospace; color: #9fd4ff; overflow-wrap: anywhere; }
.sp-bguide .kind { margin: 10px 0 0; padding: 8px 10px; background: #0e1822; border: 1px solid #23364a;
  border-radius: 4px; color: #9fb3c8; }
.sp-bguide .kind b { color: #cfe3f5; }
.sp-bguide .alt { color: #7f97ac; margin: 10px 0 0; }
`;

/** What the guide says this prop will do on the round trip — the one thing that differs by kind. */
const roundTripNote = (kind: PortalKind): string => kind === 'model'
  ? 'This is a tiled prop, so it arrives as real QUADS and comes back as quads. Its UVs are computed from '
    + 'the quad corners — Blender gets a copy of that mapping so the tile is paintable, but it is never read '
    + 'back, so reshaping the cage costs you nothing.'
  : 'This is a textured prop, so it arrives as triangles with its UV layout and one Blender material per '
    + 'slot, each wearing its actual tile. Geometry and UVs both round-trip.';

/**
 * How to take this prop to Blender and back — shown from every entry point, so the answer is the same
 * wherever it is asked.
 *
 * The add-on is the real route and the download is the fallback, and the dialog is ordered to say so: the
 * numbered steps are the live loop, and the GLB is offered underneath as the thing to do instead if you would
 * rather not install anything. Written as steps rather than prose because "install this, set that, press
 * these two buttons" is a procedure, and a paragraph makes a reader re-derive the order.
 */
export function openBlenderGuide(prop: { kind: PortalKind; id: number; name: string }): void {
  installStyles('blender-guide', guideCss);
  const { host, close } = modal();
  host.classList.add('sp-bguide');

  const title = document.createElement('h3');
  title.textContent = `Edit ${prop.name} in Blender`;
  const sub = document.createElement('p');
  sub.className = 'sub';
  sub.textContent = 'Pull it into Blender, edit it, push it back — it lands on this same prop, so every '
    + 'placement of it follows and its effects stay attached.';

  const steps = document.createElement('ol');
  for (const [text, code] of [
    ['In Blender: Edit ▸ Preferences ▸ Add-ons ▸ Install from Disk, and pick', 'blender/slopesmith_bridge.py'],
    ['Tick it on, expand it, and check the service address reads', 'http://127.0.0.1:5180'],
    ['On a server with accounts, paste an access key from Settings ▸ Integrations ▸ Access keys', ''],
    ['In the 3D view press N and open the Slopesmith tab, then Refresh and pick this mountain', ''],
    [`Select ${prop.name} in the list and press Pull`, ''],
    ['Edit it, then press Push. Come back here and it has already changed.', ''],
  ] as [string, string][]) {
    const li = document.createElement('li');
    li.append(document.createTextNode(text));
    if (code) {
      li.append(document.createTextNode(' '));
      const tag = document.createElement('code');
      tag.textContent = code;
      li.append(tag);
    }
    steps.append(li);
  }

  const kind = document.createElement('p');
  kind.className = 'kind';
  kind.innerHTML = '<b>What survives the trip.</b> ';
  kind.append(document.createTextNode(roundTripNote(prop.kind)));

  // Said separately from the geometry note because it answers a different worry — not "will my mesh come
  // back" but "am I about to overwrite a texture something else is using".
  const paint = document.createElement('p');
  paint.className = 'kind';
  paint.innerHTML = '<b>Painting on it.</b> ';
  paint.append(document.createTextNode('Texture Paint works on the tile a slot wears, and a tile you edit '
    + 'comes home with the mesh. One of your own Custom tiles is replaced, and everything wearing it '
    + 'follows; a reference level’s tile is forked into your Custom bank instead, so the original is never '
    + 'touched. A tile you did not edit is never re-uploaded.'));

  const alt = document.createElement('p');
  alt.className = 'alt';
  alt.textContent = 'Would rather not install it? Download a self-contained GLB instead — 1 unit = 1 metre, '
    + 'Y-up, textures embedded. It carries the same stamp, so the add-on can still push it back later.';

  const actions = document.createElement('div');
  actions.className = 'sp-modal-actions';
  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'sp-btn';
  download.textContent = 'Download GLB';
  download.onclick = () => { downloadBlenderGlb(prop.kind, prop.id, prop.name); close(); };
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'sp-btn accent';
  done.textContent = 'Got it';
  done.onclick = close;
  actions.append(download, done);

  host.append(title, sub, steps, kind, paint, alt, actions);
  done.focus();
}

/** One line summarising a drain, for the toast. Written here so the wording is the same wherever the drain
 *  is triggered from. */
export function describeApplied(applied: readonly AppliedPush[]): string {
  const cages = applied.filter((one): one is Extract<AppliedPush, { kind: 'model' }> => one.kind === 'model');
  const tiles = applied.length - cages.length;
  // A push that brought art back but no cage — a textured prop, whose geometry the server wrote itself —
  // reaches the editor as ref moves alone, so that is the whole sentence.
  if (!cages.length) {
    return `Blender repainted ${tiles} tile${tiles === 1 ? '' : 's'}`
      + ` — everything wearing ${tiles === 1 ? 'it' : 'them'} followed.`;
  }
  const names = cages.map(one => one.name).join(', ');
  const fanned = cages.reduce((n, one) => n + one.fanned, 0);
  const dropped = cages.reduce((n, one) => n + one.dropped, 0);
  const quads = cages.reduce((n, one) => n + one.quads, 0);
  const painted = tiles + cages.filter(one => one.retextured).length;
  return `Blender updated ${names} — ${quads.toLocaleString()} quad${quads === 1 ? '' : 's'}.`
    + (fanned ? ` ${fanned} n-gon${fanned === 1 ? '' : 's'} split.` : '')
    + (dropped ? ` ${dropped} degenerate face${dropped === 1 ? '' : 's'} dropped.` : '')
    + (painted ? ` ${painted} tile${painted === 1 ? '' : 's'} repainted.` : '');
}
