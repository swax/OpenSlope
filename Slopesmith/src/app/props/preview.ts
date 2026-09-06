import type { LevelProps } from '../../core/reference/props';
import type { GroupDef } from '../../core/reference/groups';
import { ThumbRenderer, THUMB_DEFAULT_AZIMUTH, THUMB_DEFAULT_ELEVATION, type ThumbEntry } from './thumb-renderer';
import { installStyles } from '../ui/components/styles';

/**
 * The Prop Tools preview: a live 3/4 view of the prop you're holding (picked from the library or the reference
 * world) or the placed prop you've selected — the props answer to the paint Palette's current-tile preview. Sits
 * at the top of the Tools panel in Props mode so you can see what you're about to drop. Unlike the library's
 * static swatches, this mounts its ThumbRenderer's live canvas so you can drag on it to smoothly orbit the camera
 * around the model and look it over from any angle (inspection only — it doesn't change the prop's placement).
 * The orbit angle is kept across props, so a viewing angle you like sticks as you flip through. The card reads
 * name → full model name → view → tri/vert stats; a GROUP shows its whole assembly in the view, with the
 * component list — member models and lights — below the stats (docs/015). See docs/012-props.md.
 *
 * The name is shown TWICE on purpose. The label is the browsing name, with the `Mdl_` prefix and the trailing
 * `_<n>` dropped, which is right when that number is a copy id (`FireHyDrant_Base_1005`) and wrong when it
 * distinguishes different models — Megaplex ships twenty glass panes, `Mdl_Glass_Pane_2000` through `_5004`,
 * each with its own mesh, and every one of them labels as `Glass_Pane`. The line under it is what you attach
 * an effect to.
 */

const ORBIT_SENSITIVITY = 0.01;                 // radians of orbit per pixel dragged
const MAX_ELEVATION = 1.45;                       // clamp the pitch just shy of straight over / under the model

const css = `
.pp-card { display: none; flex-direction: column; align-items: center; gap: 6px; margin: 2px 0 10px; padding: 10px;
  background: #10202e; border: 1px solid #21384c; border-radius: 8px; }
.pp-card.on { display: flex; }
.pp-thumb { width: 148px; height: 148px; background: #0b141d; border-radius: 6px; overflow: hidden;
  touch-action: none; user-select: none; }
.pp-thumb canvas { display: block; width: 148px; height: 148px; }
.pp-card.orbit .pp-thumb { cursor: grab; }
.pp-card.orbit .pp-thumb:active, .pp-card.dragging .pp-thumb { cursor: grabbing; }
.pp-name { font: 600 12px system-ui, sans-serif; color: #cfe3f5; text-align: center; word-break: break-word; }
.pp-model { font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; color: #7e93a8; text-align: center;
  word-break: break-all; margin-top: -2px; }
.pp-model:empty { display: none; }
.pp-instance { font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; color: #5f9bbf; text-align: center;
  word-break: break-all; }
.pp-instance:empty { display: none; }
.pp-stats { font: 11px system-ui, sans-serif; color: #6f8398; font-variant-numeric: tabular-nums; }
.pp-stats:empty { display: none; }
.pp-members { display: none; flex-direction: column; gap: 2px; align-self: stretch; margin-top: 2px;
  padding-top: 6px; border-top: 1px solid #21384c; }
.pp-members.on { display: flex; }
.pp-member { display: flex; align-items: center; gap: 6px; font: 11px system-ui, sans-serif; color: #9fb3c8;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pp-member .pp-ico { flex: 0 0 auto; width: 10px; text-align: center; color: #567089; }
.pp-member .pp-dot { flex: 0 0 auto; width: 9px; height: 9px; border-radius: 50%; border: 1px solid #ffffff30; }
`;

export class PropPreview {
  readonly el = document.createElement('div');
  private thumbEl = document.createElement('div');
  private nameEl = document.createElement('div');
  /** The FULL model name under the label. The label above drops the `Mdl_` prefix and the trailing `_<n>`,
   *  which reads well while browsing and is ambiguous the moment the number distinguishes different MODELS
   *  rather than copies of one — Megaplex's twenty glass panes are `Mdl_Glass_Pane_2000..5004`, each its own
   *  mesh, and every one of them labels as `Glass_Pane`. Authoring an effect per pane needs to know which. */
  private modelEl = document.createElement('div');
  /** The placed prop's own identity. Effects attach to the INSTANCE, not to the model or the material, so
   *  when twenty panes share one model name this is the line that says which one an effect will land on. */
  private instanceEl = document.createElement('div');
  private statsEl = document.createElement('div');
  private membersEl = document.createElement('div');
  private thumb = new ThumbRenderer(148);
  private token = 0;                          // guards against an out-of-order async prepare clobbering a newer one
  private hasModel = false;                   // a model is built and can be drawn / orbited
  private azimuth = THUMB_DEFAULT_AZIMUTH;    // camera orbit, persisted across props (session only)
  private elevation = THUMB_DEFAULT_ELEVATION;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private drawQueued = false;

  constructor() {
    installStyles('prop-preview', css);
    this.el.className = 'pp-card';
    this.thumbEl.className = 'pp-thumb';
    this.nameEl.className = 'pp-name';
    this.modelEl.className = 'pp-model';
    this.instanceEl.className = 'pp-instance';
    this.instanceEl.title = 'This prop’s number. Effects point at a particular prop by it, and it stays with '
      + 'the prop — deleting or reordering other props never renumbers it.';
    this.statsEl.className = 'pp-stats';
    this.membersEl.className = 'pp-members';
    this.thumbEl.append(this.thumb.canvas);
    this.el.append(this.nameEl, this.modelEl, this.instanceEl, this.thumbEl, this.statsEl, this.membersEl);
    this.wireOrbit();
  }

  /** A different mountain may reuse a compact authored texture ref for different local bytes. */
  invalidateProjectAssets(): void { this.thumb.invalidateProjectAssets(); }

  /** Pointer drag on the thumbnail orbits the camera (horizontal → azimuth, vertical → elevation). Pointer
   *  capture keeps the drag alive if the cursor leaves the little canvas. */
  private wireOrbit() {
    this.thumbEl.addEventListener('pointerdown', e => {
      if (!this.hasModel) return;
      this.dragging = true;
      this.lastX = e.clientX; this.lastY = e.clientY;
      this.el.classList.add('dragging');
      this.thumbEl.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.thumbEl.addEventListener('pointermove', e => {
      if (!this.dragging) return;
      this.azimuth -= (e.clientX - this.lastX) * ORBIT_SENSITIVITY;   // drag right → the model turns to follow
      this.elevation += (e.clientY - this.lastY) * ORBIT_SENSITIVITY; // drag down → look from lower
      this.elevation = Math.max(-MAX_ELEVATION, Math.min(MAX_ELEVATION, this.elevation));
      this.lastX = e.clientX; this.lastY = e.clientY;
      this.scheduleDraw();
    });
    const end = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.el.classList.remove('dragging');
      try { this.thumbEl.releasePointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    };
    this.thumbEl.addEventListener('pointerup', end);
    this.thumbEl.addEventListener('pointercancel', end);
  }

  /** Coalesce a burst of pointer-moves into one render per animation frame. */
  private scheduleDraw() {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      if (this.hasModel) this.thumb.view(this.azimuth, this.elevation);
    });
  }

  /** Show `model` from `map`; builds it and draws the current orbit view once its tiles load. If the level's
   *  props aren't in yet, shows the name alone. With a group def the view builds the WHOLE assembly and the
   *  component list renders below the name (docs/015). `instance` identifies a PLACED prop — the id an effect
   *  binds to — and is omitted when the card is previewing a model rather than a placement. */
  show(level: string, model: number, name: string, props: LevelProps | undefined, group?: GroupDef | null,
    instance?: string | null) {
    this.el.classList.add('on');
    this.nameEl.textContent = name;
    // Only when it says something the label does not: a prop whose full name IS the label gains nothing from
    // a second line of the same text, and a group's members carry their own names in the list below.
    const full = group ? '' : props?.models.find(x => x.id === model)?.name ?? '';
    this.modelEl.textContent = full && full !== name ? full : '';
    this.instanceEl.textContent = instance ?? '';
    this.setMembers(group ?? null);
    const entries: ThumbEntry[] = [];
    if (props) {
      const members = group?.props ?? [{ model, name, relPos: [0, 0, 0] as [number, number, number], relYaw: 0 }];
      for (const mm of members) {
        const pm = props.models.find(x => x.id === mm.model);
        if (pm) entries.push({ model: pm, relPos: mm.relPos, relYaw: mm.relYaw });
      }
    }
    // geometry stats for what the view shows — a group sums every member model
    let tris = 0, verts = 0;
    for (const e of entries) for (const s of e.model.subs) { tris += s.indices.length / 3; verts += s.positions.length / 3; }
    this.statsEl.textContent = entries.length ? `${tris.toLocaleString()} tris · ${verts.toLocaleString()} verts` : '';
    const mine = ++this.token;
    this.hasModel = false;
    this.el.classList.remove('orbit');
    if (!entries.length || !props) { this.thumb.canvas.style.visibility = 'hidden'; return; } // props not loaded — name only
    void this.thumb.prepareSet(entries, level, props.materials).then(() => {
      if (mine !== this.token) return; // a newer show()/empty() superseded this one
      this.hasModel = true;
      this.el.classList.add('orbit');
      this.thumb.canvas.style.visibility = 'visible';
      this.thumb.view(this.azimuth, this.elevation);
    });
  }

  /** The component list under the stats line — one row per member model (▪) and light (a coloured dot): what
   *  this one placement carries. Hidden for a plain prop. */
  private setMembers(group: GroupDef | null) {
    this.membersEl.replaceChildren();
    this.membersEl.classList.toggle('on', !!group);
    if (!group) return;
    const row = (marker: HTMLElement, text: string) => {
      const r = document.createElement('div');
      r.className = 'pp-member';
      const label = document.createElement('span');
      label.textContent = text;
      r.append(marker, label);
      this.membersEl.appendChild(r);
    };
    for (const m of group.props) {
      const ico = document.createElement('span');
      ico.className = 'pp-ico';
      ico.textContent = '▪';
      // Full names here rather than the browsing label: this list is what the placement CARRIES, and two
      // members that differ only in their trailing number are two different models.
      row(ico, m.name);
    }
    for (const L of group.lights) {
      const dot = document.createElement('span');
      dot.className = 'pp-dot';
      dot.style.background = L.color;
      row(dot, `${L.kind} light · ×${L.intensity.toFixed(L.intensity >= 10 ? 0 : 1)}`);
    }
  }

  hide() { this.el.classList.remove('on', 'orbit'); this.token++; }
}
