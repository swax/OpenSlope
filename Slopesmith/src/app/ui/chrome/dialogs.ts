import GUI, { type Controller } from 'lil-gui';
import type { V3 } from '../../../core/doc/types';
import type { EditDoc } from '../../../core/doc/doc-edit';
import {
  DEFAULT_BLANK_SLOPE_DEG, blankMountain, buildMeshFromCourse, courseAtHeight, courseHeight,
  coursePathFromLine, starterCourse,
} from '../../../core/doc/mountain';
import { buildQuadMesh } from '../../../core/mesh/topology';
import { RETAIL_PROPS, type Preflight, type TileClass } from '../../../core/export/preflight';
import { exportFolderName } from '../../../core/export/folder';
import { canPickDirectory, pickMapsDirectory, type ExportTarget } from '../../export/landing';
import { exportMapFolder, resolveExportTarget } from '../../export/run';
import { createMountainArchive, readMountainArchive } from '../../mountain/archive';
import { safeDataName } from '../../../core/export/names';
import { tip } from '../components/gui';
import { escapeHtml as esc } from '../components/html-escape';
import { infoBadge } from '../components/info';
import { toast } from '../components/toast';
import { modal } from '../components/modal';
import { askName, confirmAction } from '../components/prompts';
import { collisionLabMountain } from '../../../core/collision/lab';
import {
  CheckpointGoneError,
  type CheckpointChanges, type CheckpointListing, type ClientProject, type ProjectCheckpoint,
  type ProjectConflict, type RevertOutcome, type RevertRequest,
} from '../../state/project-sync';
import type { ProjectBundle } from '../../../core/project/transfer';
import { isReservedMapName } from '../../state/map-url';
import { clientFetch } from '../../net/client';

/**
 * The editor's modal dialogs + file actions (docs/011): loft a New mountain, regenerate terrain around a
 * drawn run, borrow a reference level's course line through that same generator, import / export an editable
 * mountain ZIP, the History panel over the project's checkpoints and the conflict resolution behind a refused
 * save, and the Export map flow with its summary of what the folder ships. These are the file-menu / Scene-panel actions; they mutate the
 * document through the injected setDoc + re-run loadMountain, and read the loaded reference through getters
 * so the reference subsystem stays owned by the shell.
 */

/** The recovered course line of a loaded reference level, as the dialogs read it. */
type RefLine = { source: string; points: V3[]; length: number; drop: number };

export type DialogDeps = {
  getDoc: () => EditDoc;                  // the active document (for Export)
  setDoc: (d: EditDoc) => void;           // replace the document (New / Load / borrow-a-line)
  startProject: (d: EditDoc) => Promise<void>; // give New / imported documents their own durable folder
  canCreateMountains: () => boolean;       // every editor may create a map they own
  canManageMountain: () => boolean;        // owner or moderator/admin: rename, delete, permissions
  listProjects: () => Promise<ClientProject[]>;
  openProject: (id: string) => Promise<EditDoc>;
  exportMountainBundle: () => Promise<ProjectBundle>;
  importMountainBundle: (bundle: ProjectBundle, name: string) => Promise<{ document: EditDoc; absent: string[] }>;
  duplicateMountainProject: (name: string) => Promise<{ document: EditDoc; absent: string[] }>;
  renameMountainProject: (name: string) => void;
  deleteMountainProject: (id: string) => Promise<void>;
  currentProject: () => ClientProject | null; // the open project, for the History panel's title + revision
  // History (docs/040) and the conflict resolution (docs/038), driven straight off the project service.
  listCheckpoints: () => Promise<CheckpointListing>;
  readCheckpoint: (file: string) => Promise<EditDoc>;
  exportCheckpoint: (file: string) => Promise<ProjectBundle>;
  checkpointNow: (note: string, reason?: 'named' | 'bulk') => Promise<ProjectCheckpoint | null>;
  nameCheckpoint: (file: string, note: string) => Promise<ProjectCheckpoint>;
  restoreCheckpoint: (file: string) => Promise<{ document: EditDoc; unchanged: boolean }>;
  /** How the map differs from a checkpoint, and who the room credits registers to (docs/040). */
  checkpointChanges: (file: string) => Promise<CheckpointChanges>;
  /** Put part of the map back to a checkpoint, as ordinary register assignments. */
  revertCheckpoint: (file: string, scope: RevertRequest) => Promise<RevertOutcome>;
  /** Show a checkpoint in the reference slot beside the live mountain — the `036` layer, reused. */
  compareCheckpoint: (document: EditDoc, label: string) => void;
  /** The corners and faces selected right now, by stable id — what bounds a selection revert. */
  getSelection: () => { vertices: string[]; quads: string[] };
  /** Whether this tab may change the map at all. A viewer follows read-only, so it is offered no revert. */
  isWritable: () => boolean;
  beginPreview: () => Promise<void>;
  endPreview: () => Promise<EditDoc>;
  getConflict: () => ProjectConflict | null;
  keepMine: () => Promise<void>;
  takeTheirs: () => Promise<EditDoc>;
  saveMineAsNewProject: () => Promise<void>;
  resetHistory: () => void;
  loadMountain: () => void | Promise<void>; // realize the current document into the editor
  getRefCourse: () => RefLine | null;     // the loaded reference's recovered main line, if any
  getRefLevel: () => string;              // the loaded reference level's name (for prompts)
  log: (msg: string) => void;             // append to the panel log (bake output, load errors)
};

/** A banner at the top of a modal: `tone` picks the accent (a plain instruction vs. a this-destroys-work warning).
 *  Handed back so a dialog whose shape is switchable can rewrite what it says. */
function banner(host: HTMLElement, text: string, tone: 'info' | 'warn') {
  const el = document.createElement('div');
  el.className = 'sp-modal-note';
  el.style.cssText = 'padding:8px 10px;margin-bottom:6px;font-size:12px;line-height:1.45;border-radius:4px;'
    + (tone === 'warn' ? 'color:#f0d9cf;background:#3a2a26;border-left:3px solid #c2543a;' : 'color:#cdd6e3;background:#2a2f3a;border-left:3px solid #3a6ea5;');
  el.textContent = text;
  host.insertBefore(el, host.firstChild);
  return el;
}

/** What each New-mountain shape makes, in the dialog's own banner. */
const NEW_MOUNTAIN_NOTE = {
  lofted: 'Lofts rolling terrain around an editable starter course — the same generator as Generate terrain '
    + 'from run. Height is the course’s top-to-bottom vertical extent.',
  blank: 'Creates NO terrain — just a straight guide run hanging in space at the pitch below. Build every '
    + 'surface by hand in Edit ▸ create patch (P).',
  collisionLab: 'Creates the reusable collision spec-validation lab: Garibaldi crash-bag cases with native '
    + 'modes, gates, masses and collision bursts varied independently. Export it to target GARI.',
} as const;

/** What the History panel is, in its own banner; the schedule and restore semantics ride the info badge. */
const HISTORY_NOTE = 'A checkpoint is taken every few minutes of real editing, and before a restore, a revert '
  + 'or a bulk edit. They thin with age; a named checkpoint is kept for good.';
const HISTORY_DETAIL = 'The thinning schedule: every checkpoint from the last hour, one an hour for a day, one '
  + 'a day for a week, one a week beyond that. Restoring writes the checkpoint as a NEW revision rather than '
  + 'rewinding the counter, and the document it replaces is kept the same way a named one is — so a restore or '
  + 'a revert you did not want is undone the same way, however long it takes to notice.';

/** What each checkpoint exists for, in the panel's own words. */
const CHECKPOINT_REASON: Record<ProjectCheckpoint['reason'], string> = {
  timer: 'while editing',
  named: 'named',
  restore: 'replaced by a restore',
  revert: 'replaced by a revert',
  bulk: 'before a bulk edit',
  idle: 'end of the session',
};

/** Bytes as a compact KB label, never rendering a real but tiny value as "0 KB". */
const kbText = (bytes: number): string => {
  const kb = bytes / 1024;
  if (!bytes) return '0 KB';
  if (kb < 1) return '<1 KB';
  return `${kb < 100 ? Math.round(kb * 10) / 10 : Math.round(kb)} KB`;
};

/** How long ago, in the coarsest unit that still says something — the axis the thinning schedule works along,
 *  so a listing read down the rows is also a reading of how far back the history reaches. */
function ageText(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days < 7 ? `${days} d ago` : `${Math.round(days / 7)} wk ago`;
}

/** One checkpoint as a row: how long ago it was taken, when that was, the revision it holds, what it costs on
 *  disk, and why it exists — the note someone wrote on it if there is one. */
const checkpointLabel = (checkpoint: ProjectCheckpoint) =>
  `${ageText(checkpoint.takenAt)} · ${new Date(checkpoint.takenAt).toLocaleString()} · r${checkpoint.revision}`
  + ` · ${kbText(checkpoint.bytes)} · ${checkpoint.note ? `“${checkpoint.note}”` : CHECKPOINT_REASON[checkpoint.reason]}`
  + (checkpoint.pinned ? ' · kept' : '')
  + (checkpoint.members.length ? ` · ${checkpoint.members.join(', ')}` : '');

/** The revert scope that names nobody in particular — everything that differs, whoever changed it. */
const ANYONE = '(anyone)';

/** How the map differs from one checkpoint, in one line: the register count and the phrases behind it. */
const describeCheckpointChanges = (changes: CheckpointChanges): string =>
  changes.described.length
    ? `${changes.summary.registers} registers · ${changes.described.join(' · ')}`
    : 'nothing has changed since this checkpoint';

/** What a revert is about to reach, as the confirmation says it. */
const describeScope = (who: string, bounded: boolean): string =>
  `${who === ANYONE ? 'everything that changed' : `everything ${who} changed`}`
  + (bounded ? ' in the selection' : '');

/** What the byte budget did, when it rather than the schedule decided what went. */
const budgetNote = (budget: CheckpointListing['budget']) =>
  `This mountain’s checkpoints reached their ${kbText(budget.limit)} budget on `
  + `${new Date(budget.droppedAt!).toLocaleString()}, so the ${budget.dropped} oldest unnamed ones were dropped `
  + `— earlier than the schedule alone would have taken them. They hold ${kbText(budget.bytes)} now, and named `
  + 'checkpoints were not touched.';

/**
 * The hand-authored work a terrain regenerate would throw away, named in the author's own terms. The sculpted
 * vertices go too, of course, and can't be counted — the net is always replaced whole. These are the things
 * the document records explicitly, so the warning can be specific rather than vague.
 */
function terrainLosses(doc: EditDoc): string[] {
  const out: string[] = [];
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const tiles = Object.keys(doc.quadTex ?? {}).length;
  const creases = Object.keys(doc.edgeHandles ?? {}).length;
  const twists = Object.keys(doc.quadTwist ?? {}).length;
  const freeEdges = doc.freeEdges?.length ?? 0;
  const tJunctions = doc.tJunctions?.length ?? 0;
  if (tiles) out.push(plural(tiles, 'painted tile'));
  if (creases) out.push(plural(creases, 'crease'));
  if (twists) out.push(`interior sculpt on ${plural(twists, 'patch', 'patches')}`);
  if (freeEdges) out.push(plural(freeEdges, 'free edge'));
  if (tJunctions) out.push(plural(tJunctions, 'T-junction'));
  const topo = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges).topology;
  if (topo.edgeTouchesPole?.some(Boolean)) out.push('the net’s poles');
  if (doc.quads.some(q => q[3] === q[2])) out.push('its wedge caps');
  return out;
}

export function createDialogs(deps: DialogDeps) {
  const { getDoc, setDoc, startProject, canCreateMountains, canManageMountain, listProjects, openProject,
    exportMountainBundle, importMountainBundle, duplicateMountainProject, renameMountainProject,
    deleteMountainProject, currentProject, listCheckpoints,
    readCheckpoint, exportCheckpoint, checkpointNow, nameCheckpoint, restoreCheckpoint, checkpointChanges, revertCheckpoint,
    compareCheckpoint, getSelection, isWritable, beginPreview, endPreview, getConflict,
    keepMine, takeTheirs, saveMineAsNewProject, resetHistory, loadMountain, getRefCourse, getRefLevel,
    log } = deps;
  const randomTerrainSeed = () => Math.floor(Math.random() * 0x7fffffff);

  /** A bulk destructive edit sets the project aside whole before it runs (docs/040), so the work it discards
   *  is one History row away. A ring that cannot be written is no reason to refuse the edit, so the failure is
   *  logged rather than raised. */
  async function checkpointBeforeBulk(what: string): Promise<void> {
    try { await checkpointNow(`before ${what}`, 'bulk'); }
    catch (error) { log(`checkpoint before ${what} failed: ${error instanceof Error ? error.message : error}`); }
  }

  /** A project switch is all-or-nothing: never replace browser recovery if the old project could not flush or
   * the new durable folder could not be created. */
  async function installDocument(document: EditDoc, asNewProject: boolean): Promise<boolean> {
    if (asNewProject) {
      try { await startProject(document); }
      catch (error) {
        log(`mountain creation failed — current mountain remains open\n${error instanceof Error ? error.message : error}`);
        toast('Could not create the mountain folder — the current mountain remains open.', 'err', 7000);
        return false;
      }
    }
    // Switch the browser replica only after the project service had a chance to flush the OLD document. Doing
    // this before startProject would race the new mountain into the previous project's autosave.
    if (asNewProject) resetHistory();
    setDoc(document);
    await loadMountain();
    return true;
  }

  /** Render a document the editor did not author into being: another project, a checkpoint, or the project as
   *  it stands on disk after a restore. Undo history is reset, because every state it holds was built on the
   *  document being replaced — the rule a project switch already follows. */
  async function adoptDocument(document: EditDoc): Promise<void> {
    resetHistory();
    setDoc(document);
    await loadMountain();
  }

  /**
   * Sweep fresh terrain around the run (the course-builder workflow: draw the run, grow the hill). This
   * REPLACES the net rather than deforming it, so the dialog is the confirmation step: it opens naming what
   * goes, and its action button says "Replace".
   *
   * The warning is unconditional because a SCULPTED net is indistinguishable from a generated one — nothing
   * in the document records that a brush touched it. Gating on the losses we *can* count (paint, creases,
   * twist, poles) would stay quiet on the most common authored work of all. So the net is always announced;
   * the countable losses only sharpen the message.
   */
  type TerrainDialogMode = { kind: 'current' } | { kind: 'reference'; line: RefLine } | { kind: 'new' };

  function terrainFromRunDialog(mode: TerrainDialogMode) {
    const doc = getDoc();
    const replacement = mode.kind === 'reference' ? mode.line : null;
    const isNew = mode.kind === 'new';
    const lost = isNew ? [] : terrainLosses(doc);
    const { host, close } = modal();
    const g = new GUI({ container: host, title: isNew ? 'New mountain' : 'Generate terrain from run' });

    let note: HTMLElement | null = null;
    if (isNew) {
      note = banner(host, NEW_MOUNTAIN_NOTE.lofted, 'info');
    } else {
      banner(host, `Replaces the terrain — the whole net (${doc.quads.length.toLocaleString()} patches)`
        + `${lost.length ? `, and with it ${lost.join(', ')}` : ''}, including anything you sculpted. `
        + (replacement
          ? `The current run is replaced by ${getRefLevel()}’s course line; that replacement is the terrain input. `
          : 'The current run is the terrain input and survives. ')
        + 'The sun, props, rails, lights and gems survive — though placed items '
        + 'keep their world positions, so they may end up floating or buried. Undo restores the old terrain, '
        + 'until you reload the page.', 'warn');
    }

    const sourceHeight = isNew ? 1500 : replacement?.drop ?? courseHeight(doc.course);
    const o = {
      name: 'MOUNTAIN01', shape: 'lofted' as 'lofted' | 'blank' | 'collisionLab', width: 400, height: sourceHeight,
      slope: DEFAULT_BLANK_SLOPE_DEG, roughness: 0.5, targetPatch: 50, seed: randomTerrainSeed(),
    };
    let shapeCtl: Controller | null = null;
    if (isNew) {
      tip(g.add(o, 'name').name('name'), 'Name of the exported level folder.');
      shapeCtl = tip(g.add(o, 'shape', {
        'lofted course': 'lofted', 'blank — no terrain': 'blank', 'collision lab (GARI)': 'collisionLab',
      }).name('terrain'),
        'What the new mountain starts as — the note above describes the selected choice.');
    }
    const widthCtl = tip(g.add(o, 'width', 30, 3000, 10).name('edge width (m)'), 'Full endpoint-to-endpoint width of each generated edge perpendicular to the run.');
    tip(g.add(o, 'height', 50, 6000, 10).name('height (m)'), replacement
      ? 'Vertical course extent. Lower values trim the reference line; higher values extend its downhill tail.'
      : isNew
        ? 'Top-to-bottom vertical extent of the new starter course.'
        : 'Vertical course extent. Lower values trim the run; higher values extend its downhill tail.');
    const slopeCtl = isNew
      ? tip(g.add(o, 'slope', 5, 60, 1).name('slope (°)'),
        'Pitch of the guide run; a gentler pitch carries the same drop further out.')
      : null;
    const roughCtl = tip(g.add(o, 'roughness', 0, 3, 0.05).name('roughness'), 'Random height variation: 1 is strong, values up to 3 create extreme relief.');
    tip(g.add(o, 'targetPatch', 5, 500, 5).name('target patch size (m)'), 'Desired maximum spacing across and between generated edges.');
    const seedCtl = tip(g.add(o, 'seed', 0, 0x7fffffff, 1).name(isNew ? 'generation seed' : 'terrain seed'), isNew
      ? 'Fresh each time the dialog opens; reuse a value to reproduce the starter course and terrain.'
      : 'Fresh each time the dialog opens; reuse a value to reproduce the same terrain.');
    // Blank generates no terrain, so every control that shapes a loft goes; only the guide run's pitch and the
    // net's nominal spacing (target patch size, which sizes brushes and knot widths) still mean anything.
    const applyShape = () => {
      const blank = o.shape === 'blank';
      const lab = o.shape === 'collisionLab';
      slopeCtl?.show(blank);
      widthCtl.show(!blank && !lab);
      roughCtl.show(!blank && !lab);
      seedCtl.show(!blank && !lab);
      if (note) note.textContent = NEW_MOUNTAIN_NOTE[o.shape];
    };
    shapeCtl?.onChange(applyShape);
    applyShape();
    g.add({ make: async () => {
      if (isNew && o.shape === 'collisionLab') {
        const lab = collisionLabMountain(o.name === 'MOUNTAIN01' ? 'COLLISION_LAB' : o.name);
        close();
        if (!await installDocument(lab, true)) return;
        toast('Collision lab created — follow the left bounce column downhill through all six cases, then ride the outer oracle column; export to target GARI.', 'ok', 9000);
        return;
      }
      if (isNew && o.shape === 'blank') {
        // Nothing is generated: the document starts with an empty mesh, exactly the substrate a model session
        // edits, and Edit ▸ create patch draws the first surface onto the view's construction plane.
        const empty = blankMountain(o.name, o.height, o.slope, o.targetPatch);
        close();
        if (!await installDocument(empty, true)) return;
        toast(`Blank ${empty.name}: no terrain yet — press P (Edit ▸ create patch) to draw the first surface.`, 'ok', 6500);
        return;
      }
      // Loft a brand-new mesh around the run. The old terrain — every sculpted vertex, every
      // painted cell, every crease and pole — is discarded; the run, the sun and the placed items carry over.
      const course = isNew ? starterCourse(o.height, o.width, o.seed)
        : replacement ? coursePathFromLine(replacement.points, o.width, o.height)
        : courseAtHeight(doc.course, o.height);
      const generated = buildMeshFromCourse(course, {
        widthM: o.width, roughness: o.roughness, targetPatchM: o.targetPatch, seed: o.seed,
      }, isNew ? { name: o.name, baseSurface: 1 } : {
          name: doc.name, baseSurface: doc.baseSurface, props: doc.props, lights: doc.lights,
          rails: doc.rails, gems: doc.gems, sun: doc.sun, skybox: doc.skybox, raceMusic: doc.raceMusic,
          raceMusicArrangement: doc.raceMusicArrangement,
          environmentBed: doc.environmentBed,
          boardSound: doc.boardSound,
          aiSeed: doc.aiSeed,
          effects: doc.effects,
      });
      if (!generated) { toast('The run needs at least two usable perpendicular edges to generate terrain.', 'err', 4000); return; }
      // Replacing the whole net is the bulk destructive edit a checkpoint is forced before: the terrain about
      // to be discarded goes into history whole first, so undo is not the only way back.
      if (!isNew) await checkpointBeforeBulk('regenerating the terrain');
      close();
      if (!await installDocument(generated, isNew)) return;
      toast(isNew
        ? `New ${generated.name} mountain generated at ${o.height} m with seed ${o.seed}.`
        : `Terrain generated${replacement ? ` from ${getRefLevel()}’s course` : ''} at ${o.height} m with seed ${o.seed}, smoothed, and the run seated — undo to restore the old terrain.`, 'ok', 5500);
    } }, 'make').name(isNew ? 'Create mountain' : 'Replace terrain');
    g.add({ cancel: close }, 'cancel').name('Cancel');
  }

  function newMountainDialog() {
    if (!canCreateMountains()) {
      toast('Creating a mountain requires the editor role.', 'warn', 5000);
      return;
    }
    terrainFromRunDialog({ kind: 'new' });
  }

  function genTerrainDialog() { terrainFromRunDialog({ kind: 'current' }); }

  /** Use the exact terrain-regeneration workflow, substituting only the loaded reference's recovered line. */
  function buildFromReferenceCourseDialog() {
    const ref = getRefCourse();
    if (!ref || ref.points.length < 2) { toast('Load a reference level with a course line first.', 'err'); return; }
    terrainFromRunDialog({ kind: 'reference', line: ref });
  }

  /** Hand one self-contained mountain bundle to the browser as a ZIP download. */
  function downloadMountainBundle(bundle: ProjectBundle,
    options: { filenameStem?: string; checkpoint?: boolean } = {}): string {
    const archive = createMountainArchive(bundle, options);
    const url = URL.createObjectURL(archive.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = archive.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return archive.filename;
  }

  /** Report a completed live or checkpoint export, including holes already present in its source revision. */
  function mountainExportResult(bundle: ProjectBundle, filename: string) {
    if (bundle.missing?.length) {
      toast(`Exported ${filename}, but ${bundle.missing.length} referenced asset${bundle.missing.length === 1 ? ' is' : 's are'} missing.`, 'warn', 8000);
      log(`mountain export missing assets\n${bundle.missing.join('\n')}`);
    } else toast(`✓ Exported ${filename}`, 'ok', 6000);
  }

  /** Export the current durable revision and its custom assets as an editable mountain ZIP. */
  async function exportMountain() {
    toast(`Exporting ${getDoc().name || 'mountain'}…`, 'info', 0);
    try {
      const bundle = await exportMountainBundle();
      mountainExportResult(bundle, downloadMountainBundle(bundle));
    } catch (error) {
      toast('Mountain export failed — see details', 'err');
      log(`MOUNTAIN EXPORT FAILED\n${error instanceof Error ? error.stack ?? error.message : error}`);
    }
  }

  /** Pick an exact workspace name, optionally excluding the mountain being renamed from collision checks. */
  async function askMountainName(title: string, value: string, confirmLabel: string,
    exceptProject?: string): Promise<string | null> {
    const taken = new Set((await listProjects())
      .filter(project => project.id !== exceptProject)
      .map(project => project.name.toLowerCase()));
    return askName({
      title,
      label: 'New mountain name',
      value,
      confirmLabel,
      hint: exceptProject
        ? 'Use letters, numbers, hyphens, or underscores. The mountain keeps its workspace, history, and assets.'
        : 'Use letters, numbers, hyphens, or underscores. The new mountain gets its own workspace and assets.',
      validate: candidate => {
        if (safeDataName(candidate) !== candidate) return 'Use only letters, numbers, hyphens, and underscores.';
        if (taken.has(candidate.toLowerCase())) return 'A workspace mountain already uses that name.';
        // A map's name is also its web address (state/map-url.ts). One of these would be answered by the file
        // server instead, so the mountain would work everywhere except at its own URL.
        if (isReservedMapName(candidate)) return 'That name is reserved by the editor’s own web addresses.';
        return null;
      },
    });
  }

  /** Fast same-server fork: the transfer manifest resolves every asset by hash without downloading its bytes. */
  async function duplicateMountain() {
    if (!canCreateMountains()) {
      toast('Duplicating a mountain requires the editor role.', 'warn', 5000);
      return;
    }
    try {
      const sourceName = currentProject()?.name || getDoc().name || 'mountain';
      const name = await askMountainName('Duplicate mountain', `${sourceName}_copy`, 'Duplicate');
      if (!name) return;
      const duplicated = await duplicateMountainProject(name);
      await adoptDocument(duplicated.document);
      toast(`Duplicated as ${duplicated.document.name}.`, 'ok', 6000);
    } catch (error) {
      log(`duplicate mountain failed: ${error instanceof Error ? error.stack ?? error.message : error}`);
      toast('Could not duplicate this mountain.', 'err', 7000);
    }
  }

  /** Give the current durable project a new collision-free name through the ordinary document-save path. */
  async function renameMountain() {
    const current = currentProject();
    if (!current) { toast('Rename needs an open workspace mountain.', 'info'); return; }
    if (!canManageMountain()) {
      toast('Only this mountain\'s owner or a moderator can rename it.', 'warn', 5000); return;
    }
    try {
      const name = await askMountainName('Rename mountain', current.name, 'Rename', current.id);
      if (!name || name === current.name) return;
      renameMountainProject(name);
      toast(`Renamed mountain to ${name}.`, 'ok', 5000);
    } catch (error) {
      log(`rename mountain failed: ${error instanceof Error ? error.stack ?? error.message : error}`);
      toast('Could not rename this mountain.', 'err', 7000);
    }
  }

  /** Delete the open project only after an explicit destructive confirmation. */
  async function deleteMountain() {
    const current = currentProject();
    if (!current) { toast('Delete needs an open workspace mountain.', 'info'); return; }
    if (!canManageMountain()) {
      toast('Only this mountain\'s owner or a moderator can delete it.', 'warn', 5000);
      return;
    }
    const sure = await confirmAction({
      title: `Delete ${current.name}?`,
      body: `Every revision, checkpoint, and mountain-local asset in ${current.name} will be deleted for `
        + 'everybody on this server. Its name is retired rather than freed.',
      confirmLabel: 'Delete mountain',
      danger: true,
    });
    if (!sure) return;
    try {
      await deleteMountainProject(current.id);
    } catch (error) {
      log(`delete mountain failed: ${error instanceof Error ? error.stack ?? error.message : error}`);
      toast('Could not delete this mountain.', 'err', 7000);
    }
  }

  /** Choose an existing workspace project. Import remains separate because it creates a new durable project. */
  function openProjectDialog(required = false) {
    void (async () => {
      try {
        const projects = await listProjects();
        if (!projects.length) { toast('No workspace mountains yet.', 'info'); return; }
        const { host, close } = modal({ sticky: required });
        const g = new GUI({ container: host, title: 'Open mountain' });
        const options: Record<string, string> = {};
        for (const project of projects) {
          const date = new Date(project.updatedAt).toLocaleString();
          options[`${project.name} — ${date}`] = project.id;
        }
        const state = { project: projects[0].id };
        g.add(state, 'project', options).name('mountain');
        g.add({ open: async () => {
          try {
            const document = await openProject(state.project);
            close();
            await adoptDocument(document);
            toast(`Opened ${document.name}.`, 'ok');
          } catch (error) {
            log(`open mountain failed: ${error instanceof Error ? error.message : error}`);
            toast('Could not open that mountain.', 'err');
          }
        } }, 'open').name('Open');
        if (!required) g.add({ cancel: close }, 'cancel').name('Cancel');
      } catch (error) {
        log(`mountain list failed: ${error instanceof Error ? error.message : error}`);
        toast('Could not read workspace mountains.', 'err');
      }
    })();
  }

  /**
   * File ▸ History (docs/040): the checkpoints this project holds, newest first, with the actions that use
   * them — name the project as it stands, see what has changed since one, compare it beside the live mountain,
   * preview it read-only, restore it as the next revision, fork it into a project of its own, name it so the
   * thinning schedule never reaches it, or revert part of the map back to it.
   */
  function historyDialog() {
    void (async () => {
      const open = currentProject();
      if (!open) { toast('History needs an open workspace mountain.', 'info'); return; }
      let listing: CheckpointListing;
      try { listing = await listCheckpoints(); }
      catch (error) {
        log(`checkpoint list failed: ${error instanceof Error ? error.message : error}`);
        toast('Could not read this mountain’s history.', 'err');
        return;
      }
      const { checkpoints, budget } = listing;
      // What has changed since the newest checkpoint, read before the panel is built because it also names
      // who the room credits registers to — the people a scoped revert may be aimed at. A failure here costs
      // the summary, never the panel.
      const opening = checkpoints.length
        ? await checkpointChanges(checkpoints[0].file).catch(() => null) : null;
      const { host, close } = modal();
      let closed = false;
      const dismiss = () => { if (!closed) { closed = true; close(); } };
      const g = new GUI({ container: host, title: `History — ${open.name}` });
      banner(host, HISTORY_NOTE, 'info').appendChild(infoBadge(HISTORY_DETAIL));
      if (budget.dropped) banner(host, budgetNote(budget), 'warn');
      if (!checkpoints.length) {
        banner(host, `${open.name} holds no checkpoints yet — one is taken after a few minutes of real editing, `
          + 'or now, under a note, with the button below.', 'info');
      }
      const state = { note: '', checkpoint: checkpoints[0]?.file ?? '' };
      const chosen = () => checkpoints.find(candidate => candidate.file === state.checkpoint)!;
      /**
       * The outcomes every action shares. A checkpoint that has been thinned since this listing was read is not
       * a failure the author can act on — the row was valid when it was offered — so the panel reopens on the
       * list as it now stands instead of reporting a missing file.
       */
      const act = async (what: string, run: () => Promise<void>) => {
        try { await run(); }
        catch (error) {
          if (error instanceof CheckpointGoneError) {
            dismiss();
            toast('That checkpoint was thinned while History was open — here is the list as it stands now.', 'info', 7000);
            historyDialog();
            return;
          }
          log(`could not ${what}: ${error instanceof Error ? error.message : error}`);
          toast(`Could not ${what}.`, 'err', 6000);
        }
      };
      tip(g.add(state, 'note').name('note'),
        'A note to find this moment by — “before I redid the finish area”.');
      tip(g.add({ take: () => void act('save a named checkpoint', async () => {
        const note = state.note.trim();
        if (!note) { toast('Write the note first — it is what the checkpoint is found by later.', 'info', 5000); return; }
        await checkpointNow(note);
        dismiss();
        toast(`Saved “${note}” — ${open.name} as it stands now, kept for good.`, 'ok', 6000);
      }) }, 'take').name('Save a named checkpoint'),
        'Set the mountain aside as it stands now, kept for good.',
        'Unsaved edits are written first, and a named checkpoint is kept whatever the thinning schedule does.');
      if (checkpoints.length) {
        const options: Record<string, string> = {};
        for (const checkpoint of checkpoints) options[checkpointLabel(checkpoint)] = checkpoint.file;
        // What has changed since the selected checkpoint. Read off the register model on the server, so
        // choosing between checkpoints costs a sentence rather than a download each.
        const changed = {
          summary: opening ? describeCheckpointChanges(opening) : 'reading…',
          who: ANYONE, scope: 'map' as 'map' | 'selection',
        };
        let changedCtl: Controller | null = null;
        const refreshChanges = () => {
          changed.summary = 'reading…';
          changedCtl?.updateDisplay();
          const asked = state.checkpoint;
          void checkpointChanges(asked).then(answer => {
            if (closed || state.checkpoint !== asked) return;
            changed.summary = describeCheckpointChanges(answer);
            changedCtl?.updateDisplay();
          }).catch(error => {
            if (closed || state.checkpoint !== asked) return;
            changed.summary = `could not read what changed: ${error instanceof Error ? error.message : error}`;
            changedCtl?.updateDisplay();
          });
        };
        tip(g.add(state, 'checkpoint', options).name(`checkpoint (now r${open.revision})`).onChange(refreshChanges),
          'Newest first: age, time, the revision it holds, its size, and what it was taken for.');
        changedCtl = tip(g.add(changed, 'summary').name('what changed since').disable(),
          'How this map differs from the selected checkpoint.',
          'Counted register by register: corners moved, faces repainted or retextured, objects that appeared '
          + 'or vanished, globals that differ. This is what tells you which checkpoint you actually want.');
        tip(g.add({ compare: () => void act('compare that checkpoint', async () => {
          const checkpoint = chosen();
          const document = await readCheckpoint(checkpoint.file);
          compareCheckpoint(document, `checkpoint r${checkpoint.revision}`);
          dismiss();
          toast(`${checkpointLabel(checkpoint)} is in the reference slot — Scene ▸ Reference moves it off the `
            + 'live mountain. The mountain is untouched.', 'info', 9000);
        }) }, 'compare').name('Compare beside the live mountain'),
          'Load this checkpoint into the reference slot; nothing about the mountain changes.');
        tip(g.add({ preview: () => void act('preview that checkpoint', async () => {
          const checkpoint = chosen();
          const document = await readCheckpoint(checkpoint.file);
          await beginPreview();   // autosave is held from here, so nothing the preview renders reaches the project
          dismiss();
          await adoptDocument(document);
          toast(`Previewing ${checkpointLabel(checkpoint)} — the mountain is untouched. `
            + 'File ▸ Close preview returns to it.', 'info', 9000);
        }) }, 'preview').name('Preview'),
          'Open this checkpoint read-only; autosave is held, so nothing can be written back.');
        tip(g.add({ restore: () => void act('restore that checkpoint', async () => {
          const checkpoint = chosen();
          const outcome = await restoreCheckpoint(checkpoint.file);
          dismiss();
          // Identical to what the project already holds: no revision was written, and saying so is the honest
          // answer — a button that reports a restore nothing came of is the one that looks broken.
          if (outcome.unchanged) {
            toast(`${checkpointLabel(checkpoint)} is already exactly what ${open.name} holds — nothing to restore.`,
              'info', 7000);
            return;
          }
          await adoptDocument(outcome.document);
          toast(`Restored ${checkpointLabel(checkpoint)} as revision ${currentProject()?.revision ?? '?'}.`, 'ok', 6000);
        }) }, 'restore').name('Restore'),
          'Make this checkpoint the mountain’s newest revision.',
          'The revision counter moves forward, and the document being replaced is checkpointed first and kept '
          + '— so a restore can itself be undone.');
        tip(g.add({ fork: () => void act('fork that checkpoint', async () => {
          const checkpoint = chosen();
          const document = await readCheckpoint(checkpoint.file);
          dismiss();
          if (!await installDocument(document, true)) return;
          toast(`Forked ${checkpointLabel(checkpoint)} into its own mountain — ${open.name} is untouched.`, 'ok', 6000);
        }) }, 'fork').name('Fork to a new mountain'),
          'Save this checkpoint as a separate mountain and switch to it.');
        tip(g.add({ export: () => void act('export that checkpoint', async () => {
          const checkpoint = chosen();
          const bundle = await exportCheckpoint(checkpoint.file);
          mountainExportResult(bundle, downloadMountainBundle(bundle,
            { filenameStem: open.name, checkpoint: true }));
        }) }, 'export').name('Export as mountain…'),
          'Download this revision as a portable .slopesmith.zip; importing it creates a new mountain.');
        tip(g.add({ name: () => void act('name that checkpoint', async () => {
          const note = state.note.trim();
          if (!note) { toast('Write the note first — it is what the checkpoint is found by later.', 'info', 5000); return; }
          await nameCheckpoint(chosen().file, note);
          dismiss();
          toast(`Named “${note}” — that checkpoint is kept from now on.`, 'ok', 6000);
        }) }, 'name').name('Name the selected checkpoint'),
          'Give the selected checkpoint that note; a named checkpoint is never thinned.');

        // ---- putting part of it back (docs/040) ----
        // Whole-document restore is blunt in a shared session: rolling an hour back to undo one person's
        // mistake discards everyone else's good work from that hour. A scoped revert assigns the checkpoint's
        // values to exactly the registers named, which is an ordinary edit and travels the ordinary path.
        if (isWritable()) {
          // Whoever the room credits a register to, plus the members each checkpoint records — so somebody who
          // wrote before the room was reopened can still be named.
          const who = [...new Set([...opening?.writers ?? [], ...checkpoints.flatMap(entry => entry.members)])].sort();
          const revert = g.addFolder('Revert part of the map');
          tip(revert.add(changed, 'who', [ANYONE, ...who]).name('whose work'),
            'Revert only the registers this person last changed.',
            'Anyone else’s work on the same map is left exactly where it is. A value they changed and somebody '
            + 'else changed after them belongs to the later writer and stays.');
          tip(revert.add(changed, 'scope', { 'the whole map': 'map', 'the current selection': 'selection' })
            .name('how far'),
            'The whole map, or only the corners and faces selected right now.',
            'Creases follow when both of their corners are selected. A revert puts values back and never '
            + 'brings back geometry somebody deleted — Restore is what does that.');
          tip(revert.add({ run: () => void act('revert to that checkpoint', async () => {
            const checkpoint = chosen();
            const selection = changed.scope === 'selection' ? getSelection() : null;
            if (selection && !selection.vertices.length && !selection.quads.length) {
              toast('Select the corners or faces to put back first — nothing is selected.', 'info', 6000);
              return;
            }
            const scope: RevertRequest = {
              ...(changed.who === ANYONE ? {} : { by: changed.who }),
              ...(selection ? { vertices: selection.vertices, quads: selection.quads } : {}),
            };
            const outcome = await revertCheckpoint(checkpoint.file, scope);
            dismiss();
            if (outcome.unchanged || !outcome.reverted) {
              toast(`Nothing to revert — ${describeScope(changed.who, !!selection)} already matches `
                + `${checkpointLabel(checkpoint)}.`, 'info', 7000);
              return;
            }
            await adoptDocument(outcome.document);
            toast(`Reverted ${describeScope(changed.who, !!selection)} to ${checkpointLabel(checkpoint)} — `
              + `${outcome.reverted} registers put back as revision ${currentProject()?.revision ?? '?'}. `
              + 'The document it replaced is kept, so this is undone the same way a restore is.', 'ok', 9000);
          }) }, 'run').name('Revert'),
            'Assign the checkpoint’s values to the registers this scope names.',
            'Everybody on the map is pushed them as ordinary registers, and the document being replaced is '
            + 'checkpointed and kept first.');
        }
      }
      g.add({ cancel: dismiss }, 'cancel').name('Cancel');
    })();
  }

  /** Leave a checkpoint preview: the project reopens as it stands on disk and autosave resumes. */
  function closePreview() {
    void (async () => {
      try {
        await adoptDocument(await endPreview());
        toast('Back on the live mountain.', 'ok');
      } catch (error) {
        log(`close preview failed: ${error instanceof Error ? error.message : error}`);
        toast('Could not reopen the mountain.', 'err');
      }
    })();
  }

  /**
   * The 409 resolution (docs/038): the project advanced without this tab — usually the same mountain open in
   * a second tab — so this tab's next save was refused and autosave is stopped until an outcome is chosen.
   * Dismissing this leaves the conflict standing rather than the editor dead: File ▸ Resolve conflict…
   * reopens it, and the project service still holds the three ways out.
   */
  function conflictDialog() {
    const conflict = getConflict();
    if (!conflict) { toast('This mountain is not in conflict.', 'info'); return; }
    const { host, close } = modal();
    const g = new GUI({ container: host, title: 'Mountain changed elsewhere' });
    banner(host, `${conflict.project.name} is at revision ${conflict.project.revision} on disk — another `
      + 'editor saved it while this tab was editing, so this tab’s changes were refused and autosave has '
      + 'stopped. Nothing is lost yet, and saving yours as a new mountain keeps both documents.', 'warn');
    const act = async (what: string, run: () => Promise<void>) => {
      close();
      try { await run(); }
      catch (error) {
        log(`could not ${what}: ${error instanceof Error ? error.message : error}`);
        toast(`Could not ${what} — the conflict stands; reopen it from File ▸ Resolve conflict….`, 'err', 8000);
      }
    };
    tip(g.add({ mine: () => void act('save your document', async () => {
      await keepMine();
      if (!getConflict()) toast('Your document was saved over the one on disk.', 'ok');
    }) }, 'mine').name('Keep mine'),
      'Save this tab’s document over the one on disk; the other save stays in history as a checkpoint.');
    tip(g.add({ theirs: () => void act('open the saved mountain', async () => {
      await adoptDocument(await takeTheirs());
      toast('Opened the mountain as it stands on disk.', 'ok');
    }) }, 'theirs').name('Take theirs'),
      'Discard this tab’s unsaved changes and open the mountain as saved; undo history resets.');
    const fork = g.add({ fork: () => void act('create the mountain', async () => {
      await saveMineAsNewProject();
      toast(`Saved as a new mountain — ${conflict.project.name} keeps the other editor’s save.`, 'ok', 6000);
    }) }, 'fork').name('Save mine as a new mountain');
    if (!canCreateMountains()) fork.disable();
    tip(fork, canCreateMountains()
      ? 'Keep both: this tab’s document becomes a mountain of its own and the editor follows it there.'
      : 'Creating the second mountain requires the editor role.');
    tip(g.add({ later: close }, 'later').name('Decide later'),
      'Leave the conflict standing. Autosave stays stopped until you choose; File ▸ Resolve conflict… reopens this.');
  }

  /** Import one portable mountain ZIP as a fresh workspace mountain. */
  function importMountain() {
    if (!canCreateMountains()) {
      toast('Importing a mountain requires the editor role.', 'warn', 5000);
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,application/zip';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const bundle = await readMountainArchive(f);
        const sourceName = bundle.document.name || bundle.name || 'mountain';
        const name = await askMountainName('Import mountain', sourceName, 'Import');
        if (!name) return;
        const imported = await importMountainBundle(bundle, name);
        await adoptDocument(imported.document);
        const absent = [...new Set([...(bundle.missing ?? []), ...(imported.absent ?? [])])];
        if (absent.length) {
          toast(`Imported ${imported.document.name}, with ${absent.length} missing asset${absent.length === 1 ? '' : 's'}.`, 'warn', 8000);
          log(`mountain import missing assets\n${absent.join('\n')}`);
        } else toast(`Imported ${imported.document.name}.`, 'ok', 6000);
      } catch (error) {
        log(`mountain import failed: ${error instanceof Error ? error.stack ?? error.message : error}`);
        toast(`Could not import that mountain: ${error instanceof Error ? error.message : error}`, 'err', 8000);
      }
    };
    input.click();
  }

  /**
   * The export dialog (docs/011): what this mountain ships, and the two settings that change what is written.
   * There is no target — the folder is written against none, and the disc step is `snowknife`, which holds the
   * slot table and reports its own allocation plan (`repack --dry-run`). The exported folder carries that
   * invocation, so the summary here is about the MAP.
   */
  async function exportDialog() {
    const d = getDoc();
    const state = { lighting: true, aiPaths: false };

    const { host, close } = modal();
    host.classList.add('sp-export-modal');
    const gTop = new GUI({ container: host, title: `Export map — ${d.name}` });
    tip(gTop.add(state, 'lighting').name('bake lighting'),
      'Bake the authored sun into terrain lightmaps + Lights.json.',
      'Baked regardless of the viewport sun toggle. Off ships no lighting, so a repack keeps the target '
      + 'level’s original lighting and the terrain reads flat.');
    tip(gTop.add(state, 'aiPaths').name('AI path variation'),
      'Give the six required race routes seeded lateral variation.',
      'Scene ▸ Show AI paths previews it. Off still ships six safe gate-to-center routes; Race mode requires '
      + 'exactly six AIP start entries.');
    // `banner` inserts at the top, so these read bottom-up: what happens after the export, then where it lands.
    banner(host, 'Slopesmith writes the portable map folder and stops there. Repack.md beside it carries the '
      + '“snowknife gltf” command that bakes it for Unity, and the “repack” command that builds a '
      + 'playable PS2 ISO for PCSX2 or hardware.', 'info');
    if (canPickDirectory()) {
      banner(host, `Writes ${exportFolderName(d)}/ into the Maps folder you pick. You are asked for it once `
        + 'and it is remembered, so every later export lands beside your reference maps.', 'info');
      tip(gTop.add({ choose: () => void chooseMapsFolder() }, 'choose').name('Change Maps folder…'),
        'Pick a different folder to export into. The current one is remembered until you change it.');
    } else {
      banner(host, 'This browser has no File System Access API — Firefox and Safari do not implement it — so '
        + `the map folder comes down as ${exportFolderName(d)}.zip instead. Unpack it into your Maps folder. `
        + 'A Chromium browser writes it there directly.', 'info');
    }

    const summary = document.createElement('div');
    summary.className = 'sp-preflight';
    host.appendChild(summary); // sits between the settings and the action buttons
    const actions = document.createElement('div');
    actions.className = 'sp-modal-actions';
    const cancel = document.createElement('button');
    cancel.className = 'sp-btn';
    cancel.textContent = 'Cancel';
    cancel.onclick = close;
    const go = document.createElement('button');
    go.className = 'sp-btn accent';
    go.textContent = 'Export map';
    go.onclick = () => { close(); void runExport(d, state.lighting, state.aiPaths); };
    actions.append(cancel, go);
    host.appendChild(actions);

    summary.innerHTML = '<div class="pf-dim">reading the mountain…</div>';
    try {
      const res = await clientFetch('/api/preflight', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ doc: d }),
      });
      // The /api/preflight middleware registers only at server start. If the running dev server predates it,
      // Vite serves index.html here (or a 404) instead of JSON — the fix is a dev-server restart, not the app.
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) {
        summary.innerHTML = '<div class="pf-warn">preflight endpoint missing — restart the dev server (Ctrl+C, <code>npm run dev</code>) to pick it up.</div>';
        return;
      }
      const pf = await res.json() as Preflight;
      if ((pf as unknown as { error?: string }).error) {
        summary.innerHTML = `<div class="pf-warn">preflight failed — ${esc((pf as unknown as { error: string }).error.split('\n')[0])}</div>`;
        return;
      }
      renderPreflight(summary, pf);
    } catch (e) {
      summary.innerHTML = `<div class="pf-warn">preflight failed — ${esc(e instanceof Error ? e.message : String(e))}</div>`;
    }
  }

  /** Re-point the folder every export writes into. */
  async function chooseMapsFolder() {
    const picked = await pickMapsDirectory();
    if (picked) toast(`Exports will be written into ${picked.name}/.`, 'ok');
  }

  /**
   * Compose the map folder here in the browser and land it. One portable form, against no target: authored
   * coordinates are written as-is (editorFromRaw <-> toRaw are exact inverses), so a mountain authored in a
   * reference level's frame lands back in its coordinates, and the folder's own Repack.md carries the
   * commands that bake it for Unity and build a disc from it.
   */
  async function runExport(d: EditDoc, lighting = true, aiPaths = false) {
    let target: ExportTarget | null;
    // Resolved first, because picking a folder may prompt and the prompt belongs to this click.
    try { target = await resolveExportTarget(d); }
    catch (e) {
      toast('Export failed — see details', 'err');
      log(`export failed: ${e instanceof Error ? e.message : e}`);
      return;
    }
    if (!target) {
      toast('No folder chosen — pick your Maps folder to export into.', 'info', 5000);
      return;
    }
    toast(`Exporting ${d.name}…`, 'info', 0);
    try {
      const result = await exportMapFolder(d, target, { lighting, aiPaths });
      toast(`✓ Exported ${d.name} → ${result.destination}`, 'ok', 6000);
      log(`${result.destination}\n\n${result.log}`); // the full export report remains available in the panel
    } catch (e) {
      toast('Export failed — see details', 'err');
      log(`EXPORT FAILED\n${e instanceof Error ? e.stack ?? e.message : e}`);
    }
  }

  return { newMountainDialog, genTerrainDialog, buildFromReferenceCourseDialog, openProjectDialog,
    historyDialog, closePreview, conflictDialog, renameMountain, duplicateMountain, deleteMountain,
    exportMountain, importMountain, exportDialog };
}

export type Dialogs = ReturnType<typeof createDialogs>;

/** Sum the cells covered by the tiles of one class. */
function classCells(pf: Preflight, cls: TileClass): number {
  return pf.tiles.filter(t => t.cls === cls).reduce((n, t) => n + t.cells, 0);
}

const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? '' : 's'}`;

/** Render the preflight into the dialog (docs/011): what the folder will contain — cells painted, the tiles
 *  they use, the models the props bake from, and the sky. Nothing here is target-relative; a disc's own
 *  numbers come from `snowknife repack --dry-run`, which the exported folder's Repack.md spells out.
 *
 *  The panel is assembled as markup, so every document-supplied string — tile refs, model and sky names —
 *  goes through `esc`: they are values any editor of the mountain can set, and this dialog is opened by
 *  whoever exports, admins included. */
function renderPreflight(el: HTMLElement, pf: Preflight) {
  // Diagnostics stay collapsed by default; preserve the user's choice across a re-render.
  const detailsOpen = !!el.querySelector<HTMLDetailsElement>('details.pf-more')?.open;
  const rows: string[] = [];
  const c = pf.counts;
  rows.push('<div class="pf-head"><b>Portable map folder</b><span class="pf-status">Unity + disc</span></div>');
  rows.push(`<div class="pf-line">${plural(pf.cells.painted, 'painted cell')} · ${plural(pf.tiles.length, 'tile')}`
    + ` · ${plural(pf.cells.unpainted, 'procedural cell')}</div>`);
  if (pf.props) {
    const p = pf.props;
    rows.push(`<div class="pf-line">${plural(p.placements, 'prop')} · ${plural(p.models, 'model')}`
      + ` · ${p.bakedTris.toLocaleString()} baked triangles · ${plural(p.pages.length, 'prop page')}</div>`);
  }

  const detail: string[] = [];
  if (c.real) detail.push(`<div class="pf-line">🟢 ${plural(c.real, 'extracted tile')} · `
    + `${plural(classCells(pf, 'real'), 'cell')} — shipped flattened and verbatim</div>`);
  if (c.custom) detail.push(`<div class="pf-line">🔴 ${plural(c.custom, 'custom tile')} · `
    + `${plural(classCells(pf, 'custom'), 'cell')} — your own art, encoded when a disc is built</div>`);
  detail.push(...pf.tiles.map(t =>
    `<div class="pf-line pf-dim">${t.cls === 'custom' ? '🔴' : '🟢'} ${esc(t.ref)} · ${plural(t.cells, 'cell')}</div>`));
  if (pf.sky) detail.push(skyLine(pf.sky));
  if (pf.props) detail.push(propRows(pf.props));
  if (pf.importedModels?.length) detail.push(importedModelRows(pf));
  rows.push(`<details class="pf-more"><summary>What ships</summary><div class="pf-more-body">${detail.join('')}</div></details>`);
  el.innerHTML = rows.join('');
  if (detailsOpen) el.querySelector<HTMLDetailsElement>('details.pf-more')?.toggleAttribute('open', true);
}

/** The sky's bank cost (docs/025) — its OWN `_sky.ssh`, so it gets its own line. A donor sky lifts verbatim
 *  (free); a custom one encodes forced type-5 pages, exactly priced: standard ≈ a retail day sky's native
 *  ~0.85 MB (the proven zone), high unproven. */
function skyLine(sky: NonNullable<Preflight['sky']>): string {
  if (sky.kind === 'level') {
    return `<div class="pf-line pf-dim">Sky: ${esc(sky.level)}’s own — its bank lifts verbatim, no VRAM change.</div>`;
  }
  const mb = (sky.bytes / 1048576).toFixed(1);
  return sky.tier === 'high'
    ? `<div class="pf-line">Sky: ★ ${esc(sky.name)} · high tier · ${sky.pages}-page type-5 _sky.ssh ≈ ${mb} MB `
      + '<span class="pf-warn">— ~4× a retail sky; this tier’s hardware budget is unproven. Standard is the safe pick.</span></div>'
    : `<div class="pf-line pf-dim">Sky: ★ ${esc(sky.name)} · standard tier · ${sky.pages}-page type-5 _sky.ssh ≈ ${mb} MB `
      + '(its own bank — on par with a retail day sky’s native ~0.85 MB).</div>';
}

/**
 * What the props cost, read against the shipped seven (`RETAIL_PROPS`, measured by `npm run budget`).
 *
 * **Pages** run out first: a repacked level's bank is a fixed list and every tile a prop material names
 * claims a slot, flipbook frames included, however many times the model is placed. **Baked** triangles are
 * what the level actually ships — the export writes one model, one mesh and one instance per placement, so
 * this is the disc's geometry as well as Unity's, and it is read against retail's DISTINCT-geometry band
 * rather than its baked one. **Geometry** is the distinct art in use, which says how modular the map is.
 */
function propRows(p: NonNullable<Preflight['props']>): string {
  const band = (range: readonly [number, number] | readonly number[]) =>
    `${range[0].toLocaleString()}–${range[1].toLocaleString()}`;
  const rows = p.rows.slice(0, 12).map(r =>
    `▪ ${esc(r.source)}/${esc(r.name)} · ${r.placements} × ${r.tris.toLocaleString()} tris · `
    + `${plural(r.pages, 'page')}`);
  if (p.rows.length > rows.length) rows.push(`<span class="pf-dim">…and ${p.rows.length - rows.length} more</span>`);
  for (const gone of p.missing) rows.push(`<span class="pf-warn">⚠ ${esc(gone)} — model not found; the bake will warn</span>`);
  const overPages = p.pages.length > RETAIL_PROPS.pages[1];
  const overBaked = p.bakedTris > RETAIL_PROPS.geomTris[1];
  rows.push(`<span class="pf-dim">${p.geomTris.toLocaleString()} triangles of distinct art in use across`
    + ` ${plural(p.models, 'model')}</span>`);
  rows.push(`<span class="${overBaked ? 'pf-warn' : 'pf-dim'}">${p.bakedTris.toLocaleString()} baked — one`
    + ` mesh per placement, so this is what the level carries; retail levels carry`
    + ` ${band(RETAIL_PROPS.geomTris)}${overBaked ? ' — over the heaviest shipped level' : ''}</span>`);
  rows.push(`<span class="${overPages ? 'pf-warn' : 'pf-dim'}">${plural(p.pages.length, 'page')} claimed by prop`
    + ` art — a retail bank holds ${band(RETAIL_PROPS.pages)} between terrain and props</span>`);
  rows.push(`<span class="pf-dim">${p.pages.map(esc).join(' · ')}</span>`);
  return `<div class="pf-detail"><b>Props</b><br>${rows.join('<br>')}</div>`;
}

/** The imported GLB models the doc places (docs/032): one row per model — placements × per-copy tris — with a
 *  baked-triangle total that goes loud at the export log's own ~150k flag point. Geometry bakes once per
 *  placement, so this is where a heavy generated prop is legible as a model rather than as a texture row. */
function importedModelRows(pf: Preflight): string {
  const models = pf.importedModels ?? [];
  const rows = models.map(m => m.missing
    ? `⚠ ${esc(m.name)} · ${plural(m.placements, 'placement')} · record missing — bakes as a warning`
    : `▪ ${esc(m.name)} · ${m.placements} × ${m.tris.toLocaleString()} tris`);
  const baked = models.reduce((n, m) => n + m.placements * m.tris, 0);
  const heavy = baked > 150_000;   // the export log's own imported-density flag point (docs/032)
  rows.push(`<span class="${heavy ? 'pf-warn' : 'pf-dim'}">${baked.toLocaleString()} baked triangle(s) total`
    + `${heavy ? ' — heavy; the export log will flag this' : ''}</span>`);
  return `<div class="pf-detail"><b>Imported models</b><br>${rows.join('<br>')}</div>`;
}
