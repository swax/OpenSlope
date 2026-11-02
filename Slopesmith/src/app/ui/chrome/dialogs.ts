import GUI, { type Controller } from 'lil-gui';
import type { V3 } from '../../../core/doc/types';
import type { EditDoc } from '../../../core/doc/doc-edit';
import {
  DEFAULT_BLANK_SLOPE_DEG,
  DEFAULT_COURSE_HEIGHT_M,
  DEFAULT_TERRAIN_WIDTH_M,
  DEFAULT_PATCH_SIZE_M,
  blankMountain,
  buildMeshFromCourse,
  coursePathFromLine,
  starterCourse,
} from '../../../core/doc/mountain';
import { buildQuadMesh } from '../../../core/mesh/topology';
import { exportFolderName } from '../../../core/export/folder';
import { exportMapFolder, resolveExportTarget } from '../../export/run';
import { createSnowknifeCommands, snowknifeTarget } from '../../export/commands';
import { createMountainArchive } from '../../mountain/archive';
import { safeDataName } from '../../../core/export/names';
import { tip } from '../components/gui';
import { infoBadge } from '../components/info';
import { toast } from '../components/toast';
import { modal } from '../components/modal';
import { askName, confirmAction } from '../components/prompts';
import {
  CheckpointGoneError,
  type CheckpointChanges,
  type CheckpointListing,
  type ClientProject,
  type ProjectCheckpoint,
  type ProjectConflict,
  type RevertOutcome,
  type RevertRequest,
} from '../../state/project-sync';
import type { ProjectBundle } from '../../../core/project/transfer';
import { isLocalWorkspace } from '../../net/workspace';
import { showAssetMigration } from './asset-migration';

/**
 * The editor's modal dialogs + file actions (docs/011): loft a New mountain, borrow a reference level's course
 * line through that same generator, import / export an editable
 * mountain ZIP, the History panel over the project's checkpoints and the conflict resolution behind a refused
 * save, and the Export map flow. These are the file-menu / Scene-panel actions; they mutate the
 * document through the injected setDoc + re-run loadMountain, and read the loaded reference through getters
 * so the reference subsystem stays owned by the shell.
 */

/** The recovered course line of a loaded reference level, as the dialogs read it. */
type RefLine = { source: string; points: V3[]; length: number; drop: number };

export type DialogDeps = {
  getDoc: () => EditDoc; // the active document (for Export)
  setDoc: (d: EditDoc) => void; // replace the document (New / Load / borrow-a-line)
  startProject: (d: EditDoc) => Promise<void>; // give New / imported documents their own durable folder
  canCreateMountains: () => boolean; // every editor may create a map they own
  canManageMountain: () => boolean; // owner or moderator/admin: rename, delete, permissions
  listProjects: () => Promise<ClientProject[]>;
  openProject: (id: string) => Promise<EditDoc>;
  /** Browser mountains from a server editor, or accessible server mountains from a browser editor. */
  listOtherProjects: () => Promise<ClientProject[]>;
  openOtherProject: (project: ClientProject) => Promise<void>;
  exportMountainBundle: () => Promise<ProjectBundle>;
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
  getRefCourse: () => RefLine | null; // the loaded reference's recovered main line, if any
  getRefLevel: () => string; // the loaded reference level's name (for prompts)
  log: (msg: string) => void; // append to the panel log (bake output, load errors)
};

/** A banner at the top of a modal: `tone` picks the accent (a plain instruction vs. a this-destroys-work warning).
 *  Handed back so a dialog whose shape is switchable can rewrite what it says. */
function banner(host: HTMLElement, text: string, tone: 'info' | 'warn') {
  const el = document.createElement('div');
  el.className = 'sp-modal-note';
  el.style.cssText =
    'padding:8px 10px;margin-bottom:6px;font-size:12px;line-height:1.45;border-radius:4px;' +
    (tone === 'warn'
      ? 'color:#f0d9cf;background:#3a2a26;border-left:3px solid #c2543a;'
      : 'color:#cdd6e3;background:#2a2f3a;border-left:3px solid #3a6ea5;');
  el.textContent = text;
  host.insertBefore(el, host.firstChild);
  return el;
}

/** What each New-mountain shape makes, in the dialog's own banner. */
const NEW_MOUNTAIN_NOTE = {
  lofted:
    'Lofts rolling terrain around an editable starter course — the same generator a reference course ' +
    'builds with. Height is the course’s top-to-bottom vertical extent.',
  blank:
    'Creates NO terrain — just a straight guide run hanging in space at the pitch below. Build every ' +
    'surface by hand in Edit ▸ create patch (P).',
} as const;

/** What the History panel is, in its own banner; the schedule and restore semantics ride the info badge. */
const HISTORY_NOTE =
  'A checkpoint is taken every few minutes of real editing, and before a restore, a revert ' +
  'or a bulk edit. They thin with age; a named checkpoint is kept for good.';
const HISTORY_DETAIL =
  'The thinning schedule: every checkpoint from the last hour, one an hour for a day, one ' +
  'a day for a week, one a week beyond that. Restoring writes the checkpoint as a NEW revision rather than ' +
  'rewinding the counter, and the document it replaces is kept the same way a named one is — so a restore or ' +
  'a revert you did not want is undone the same way, however long it takes to notice.';

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
  `${ageText(checkpoint.takenAt)} · ${new Date(checkpoint.takenAt).toLocaleString()} · r${checkpoint.revision}` +
  ` · ${kbText(checkpoint.bytes)} · ${checkpoint.note ? `“${checkpoint.note}”` : CHECKPOINT_REASON[checkpoint.reason]}` +
  (checkpoint.pinned ? ' · kept' : '') +
  (checkpoint.members.length ? ` · ${checkpoint.members.join(', ')}` : '');

/** The revert scope that names nobody in particular — everything that differs, whoever changed it. */
const ANYONE = '(anyone)';

/** How the map differs from one checkpoint, in one line: the register count and the phrases behind it. */
const describeCheckpointChanges = (changes: CheckpointChanges): string =>
  changes.described.length
    ? `${changes.summary.registers} registers · ${changes.described.join(' · ')}`
    : 'nothing has changed since this checkpoint';

/** What a revert is about to reach, as the confirmation says it. */
const describeScope = (who: string, bounded: boolean): string =>
  `${who === ANYONE ? 'everything that changed' : `everything ${who} changed`}` + (bounded ? ' in the selection' : '');

/** What the byte budget did, when it rather than the schedule decided what went. */
const budgetNote = (budget: CheckpointListing['budget']) =>
  `This mountain’s checkpoints reached their ${kbText(budget.limit)} budget on ` +
  `${new Date(budget.droppedAt!).toLocaleString()}, so the ${budget.dropped} oldest unnamed ones were dropped ` +
  `— earlier than the schedule alone would have taken them. They hold ${kbText(budget.bytes)} now, and named ` +
  'checkpoints were not touched.';

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
  const {
    getDoc,
    setDoc,
    startProject,
    canCreateMountains,
    canManageMountain,
    listProjects,
    openProject,
    listOtherProjects,
    openOtherProject,
    exportMountainBundle,
    duplicateMountainProject,
    renameMountainProject,
    deleteMountainProject,
    currentProject,
    listCheckpoints,
    readCheckpoint,
    exportCheckpoint,
    checkpointNow,
    nameCheckpoint,
    restoreCheckpoint,
    checkpointChanges,
    revertCheckpoint,
    compareCheckpoint,
    getSelection,
    isWritable,
    beginPreview,
    endPreview,
    getConflict,
    keepMine,
    takeTheirs,
    saveMineAsNewProject,
    resetHistory,
    loadMountain,
    getRefCourse,
    getRefLevel,
    log,
  } = deps;
  const randomTerrainSeed = () => Math.floor(Math.random() * 0x7fffffff);

  /** A bulk destructive edit sets the project aside whole before it runs (docs/040), so the work it discards
   *  is one History row away. A ring that cannot be written is no reason to refuse the edit, so the failure is
   *  logged rather than raised. */
  async function checkpointBeforeBulk(what: string): Promise<void> {
    try {
      await checkpointNow(`before ${what}`, 'bulk');
    } catch (error) {
      log(`checkpoint before ${what} failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** A project switch is all-or-nothing: never replace browser recovery if the old project could not flush or
   * the new durable folder could not be created. */
  async function installDocument(document: EditDoc, asNewProject: boolean): Promise<boolean> {
    if (asNewProject) {
      try {
        await startProject(document);
      } catch (error) {
        log(
          `mountain creation failed — current mountain remains open\n${error instanceof Error ? error.message : error}`,
        );
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
   * Sweep fresh terrain around a run: a brand-new mountain's starter course, or the loaded reference's
   * recovered line. The reference flow REPLACES the net rather than deforming it, so the dialog is the
   * confirmation step: it opens naming what goes, and its action button says "Replace".
   *
   * The warning is unconditional because a SCULPTED net is indistinguishable from a generated one — nothing
   * in the document records that a brush touched it. Gating on the losses we *can* count (paint, creases,
   * twist, poles) would stay quiet on the most common authored work of all. So the net is always announced;
   * the countable losses only sharpen the message.
   */
  type TerrainDialogMode = { kind: 'reference'; line: RefLine } | { kind: 'new' };

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
      banner(
        host,
        `Replaces the terrain — the whole net (${doc.quads.length.toLocaleString()} patches)` +
          `${lost.length ? `, and with it ${lost.join(', ')}` : ''}, including anything you sculpted. ` +
          `The current run is replaced by ${getRefLevel()}’s course line; that replacement is the terrain input. ` +
          'The sun, props, rails, lights and gems survive — though placed items ' +
          'keep their world positions, so they may end up floating or buried. Undo restores the old terrain, ' +
          'until you reload the page.',
        'warn',
      );
    }

    const sourceHeight = replacement?.drop ?? DEFAULT_COURSE_HEIGHT_M;
    const o = {
      name: 'MOUNTAIN01',
      shape: 'lofted' as 'lofted' | 'blank',
      width: DEFAULT_TERRAIN_WIDTH_M,
      height: sourceHeight,
      slope: DEFAULT_BLANK_SLOPE_DEG,
      roughness: 0.5,
      targetPatch: DEFAULT_PATCH_SIZE_M,
      seed: randomTerrainSeed(),
    };
    let shapeCtl: Controller | null = null;
    if (isNew) {
      tip(g.add(o, 'name').name('name'), 'Name of the exported level folder.');
      shapeCtl = tip(
        g
          .add(o, 'shape', {
            'lofted course': 'lofted',
            'blank — no terrain': 'blank',
          })
          .name('terrain'),
        'What the new mountain starts as — the note above describes the selected choice.',
      );
    }
    const widthCtl = tip(
      g.add(o, 'width', 30, 3000, 10).name('edge width (m)'),
      'Full endpoint-to-endpoint width of each generated edge perpendicular to the run.',
    );
    tip(
      g.add(o, 'height', 50, 6000, 10).name('height (m)'),
      replacement
        ? 'Vertical course extent. Lower values trim the reference line; higher values extend its downhill tail.'
        : 'Top-to-bottom vertical extent of the new starter course.',
    );
    const slopeCtl = isNew
      ? tip(
          g.add(o, 'slope', 5, 60, 1).name('slope (°)'),
          'Pitch of the guide run; a gentler pitch carries the same drop further out.',
        )
      : null;
    const roughCtl = tip(
      g.add(o, 'roughness', 0, 3, 0.05).name('roughness'),
      'Random height variation: 1 is strong, values up to 3 create extreme relief.',
    );
    tip(
      g.add(o, 'targetPatch', 5, 500, 5).name('target patch size (m)'),
      'Desired maximum spacing across and between generated edges.',
    );
    const seedCtl = tip(
      g.add(o, 'seed', 0, 0x7fffffff, 1).name(isNew ? 'generation seed' : 'terrain seed'),
      isNew
        ? 'Fresh each time the dialog opens; reuse a value to reproduce the starter course and terrain.'
        : 'Fresh each time the dialog opens; reuse a value to reproduce the same terrain.',
    );
    // Blank generates no terrain, so every control that shapes a loft goes; only the guide run's pitch and the
    // net's nominal spacing (target patch size, which sizes brushes and knot widths) still mean anything.
    const applyShape = () => {
      const blank = o.shape === 'blank';
      slopeCtl?.show(blank);
      widthCtl.show(!blank);
      roughCtl.show(!blank);
      seedCtl.show(!blank);
      if (note) note.textContent = NEW_MOUNTAIN_NOTE[o.shape];
    };
    shapeCtl?.onChange(applyShape);
    applyShape();
    g.add(
      {
        make: async () => {
          if (isNew && o.shape === 'blank') {
            // Nothing is generated: the document starts with an empty mesh, exactly the substrate a model session
            // edits, and Edit ▸ create patch draws the first surface onto the view's construction plane.
            const empty = blankMountain(o.name, o.height, o.slope, o.targetPatch);
            close();
            if (!(await installDocument(empty, true))) return;
            toast(
              `Blank ${empty.name}: no terrain yet — press P (Edit ▸ create patch) to draw the first surface.`,
              'ok',
              6500,
            );
            return;
          }
          // Loft a brand-new mesh around the run. Replacing from a reference line discards the old terrain — every
          // sculpted vertex, every painted cell, every crease and pole; the sun and the placed items carry over.
          const course = replacement
            ? coursePathFromLine(replacement.points, o.height)
            : starterCourse(o.height, o.seed);
          const generated = buildMeshFromCourse(
            course,
            {
              widthM: o.width,
              roughness: o.roughness,
              targetPatchM: o.targetPatch,
              seed: o.seed,
            },
            isNew
              ? { name: o.name, baseSurface: 1 }
              : {
                  name: doc.name,
                  baseSurface: doc.baseSurface,
                  props: doc.props,
                  lights: doc.lights,
                  rails: doc.rails,
                  gems: doc.gems,
                  sun: doc.sun,
                  skybox: doc.skybox,
                  raceMusic: doc.raceMusic,
                  raceMusicArrangement: doc.raceMusicArrangement,
                  environmentBed: doc.environmentBed,
                  boardSound: doc.boardSound,
                  announcer: doc.announcer,
                  aiSeed: doc.aiSeed,
                  effects: doc.effects,
                },
          );
          if (!generated) {
            toast('The run needs at least two usable perpendicular edges to generate terrain.', 'err', 4000);
            return;
          }
          // Replacing the whole net is the bulk destructive edit a checkpoint is forced before: the terrain about
          // to be discarded goes into history whole first, so undo is not the only way back.
          if (!isNew) await checkpointBeforeBulk('regenerating the terrain');
          close();
          if (!(await installDocument(generated, isNew))) return;
          toast(
            isNew
              ? `New ${generated.name} mountain generated at ${o.height} m with seed ${o.seed}.`
              : `Terrain generated from ${getRefLevel()}’s course at ${o.height} m with seed ${o.seed}, smoothed, and the run seated — undo to restore the old terrain.`,
            'ok',
            5500,
          );
        },
      },
      'make',
    ).name(isNew ? 'Create mountain' : 'Replace terrain');
    g.add({ cancel: close }, 'cancel').name('Cancel');
  }

  function newMountainDialog() {
    if (!canCreateMountains()) {
      toast('Creating a mountain requires the editor role.', 'warn', 5000);
      return;
    }
    terrainFromRunDialog({ kind: 'new' });
  }

  /** Use the exact terrain-regeneration workflow, substituting only the loaded reference's recovered line. */
  function buildFromReferenceCourseDialog() {
    const ref = getRefCourse();
    if (!ref || ref.points.length < 2) {
      toast('Load a reference level with a course line first.', 'err');
      return;
    }
    terrainFromRunDialog({ kind: 'reference', line: ref });
  }

  /** Hand one self-contained mountain bundle to the browser as a ZIP download. */
  function downloadMountainBundle(
    bundle: ProjectBundle,
    options: { filenameStem?: string; checkpoint?: boolean } = {},
  ): string {
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
      toast(
        `Exported ${filename}, but ${bundle.missing.length} referenced asset${bundle.missing.length === 1 ? ' is' : 's are'} missing.`,
        'warn',
        8000,
      );
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
      log(`MOUNTAIN EXPORT FAILED\n${error instanceof Error ? (error.stack ?? error.message) : error}`);
    }
  }

  /** Pick an exact workspace name, optionally excluding the mountain being renamed from collision checks. */
  async function askMountainName(
    title: string,
    value: string,
    confirmLabel: string,
    exceptProject?: string,
  ): Promise<string | null> {
    const taken = new Set(
      (await listProjects()).filter(project => project.id !== exceptProject).map(project => project.name.toLowerCase()),
    );
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
      log(`duplicate mountain failed: ${error instanceof Error ? (error.stack ?? error.message) : error}`);
      toast('Could not duplicate this mountain.', 'err', 7000);
    }
  }

  /** Give the current durable project a new collision-free name through the ordinary document-save path. */
  async function renameMountain() {
    const current = currentProject();
    if (!current) {
      toast('Rename needs an open workspace mountain.', 'info');
      return;
    }
    if (!canManageMountain()) {
      toast("Only this mountain's owner or a moderator can rename it.", 'warn', 5000);
      return;
    }
    try {
      const name = await askMountainName('Rename mountain', current.name, 'Rename', current.id);
      if (!name || name === current.name) return;
      renameMountainProject(name);
      toast(`Renamed mountain to ${name}.`, 'ok', 5000);
    } catch (error) {
      log(`rename mountain failed: ${error instanceof Error ? (error.stack ?? error.message) : error}`);
      toast('Could not rename this mountain.', 'err', 7000);
    }
  }

  /** Delete the open project only after an explicit destructive confirmation. */
  async function deleteMountain() {
    const current = currentProject();
    if (!current) {
      toast('Delete needs an open workspace mountain.', 'info');
      return;
    }
    if (!canManageMountain()) {
      toast("Only this mountain's owner or a moderator can delete it.", 'warn', 5000);
      return;
    }
    const sure = await confirmAction({
      title: `Delete ${current.name}?`,
      body: isLocalWorkspace()
        ? `The browser copy of ${current.name} and its custom assets will be deleted. Folder copies and downloaded backups are kept.`
        : `Every revision, checkpoint, and mountain-local asset in ${current.name} will be deleted for ` +
          'everybody on this server. Its name is retired rather than freed.',
      confirmLabel: 'Delete mountain',
      danger: true,
    });
    if (!sure) return;
    try {
      await deleteMountainProject(current.id);
    } catch (error) {
      log(`delete mountain failed: ${error instanceof Error ? (error.stack ?? error.message) : error}`);
      toast('Could not delete this mountain.', 'err', 7000);
    }
  }

  /** Choose a saved mountain in either workspace; changing storage also changes the editor's workspace. */
  function openProjectDialog(required = false) {
    void (async () => {
      try {
        const local = isLocalWorkspace();
        const [workspace, other] = await Promise.all([listProjects(), listOtherProjects()]);
        const projects = [
          ...workspace.map(project => ({ project, local, other: false })),
          ...other.map(project => ({ project, local: !local, other: true })),
        ];
        if (!projects.length) {
          toast('No saved mountains yet.', 'info');
          return;
        }
        const { host, close } = modal({ sticky: required });
        const g = new GUI({ container: host, title: 'Open mountain' });
        const state = { source: projects[0].local ? 'local' : 'server', project: '0' };
        const remembered = new Map<string, string>();
        const locationNote = banner(host, '', 'info');
        const showLocation = () => {
          locationNote.textContent =
            state.source === 'local'
              ? 'Local mountains — saved in this browser on this device.'
              : `Server mountains — saved on ${location.host}.`;
          if (!state.project) locationNote.textContent += ' No saved mountains in this source.';
        };
        const sourceCtl = g.add(state, 'source', { Local: 'local', Server: 'server' }).name('source');
        sourceCtl.domElement.querySelector('select')!.setAttribute('aria-label', 'Mountain source');
        sourceCtl.domElement.querySelector('select')!.removeAttribute('aria-labelledby');
        const mountainCtl = g.add(state, 'project', { '(none)': '' }).name('mountain');
        mountainCtl.domElement.querySelector('select')!.setAttribute('aria-label', 'Saved mountain');
        mountainCtl.domElement.querySelector('select')!.removeAttribute('aria-labelledby');
        const openCtl = g
          .add(
            {
              open: async () => {
                try {
                  const selected = projects[Number(state.project)];
                  if (!state.project || !selected || selected.local !== (state.source === 'local')) return;
                  if (selected.other) {
                    await openOtherProject(selected.project);
                    return;
                  }
                  const document = await openProject(selected.project.id);
                  close();
                  await adoptDocument(document);
                  toast(`Opened ${document.name}.`, 'ok');
                } catch (error) {
                  log(`open mountain failed: ${error instanceof Error ? error.message : error}`);
                  toast('Could not open that mountain.', 'err');
                }
              },
            },
            'open',
          )
          .name('Open');
        const fillMountains = () => {
          const available = projects.flatMap((entry, index) =>
            entry.local === (state.source === 'local') ? [{ ...entry, index: String(index) }] : [],
          );
          const options: Record<string, string> = {};
          for (const { project, index } of available)
            options[`${project.name} — ${new Date(project.updatedAt).toLocaleString()}`] = index;
          const previous = remembered.get(state.source);
          state.project = available.find(entry => entry.index === previous)?.index ?? available[0]?.index ?? '';
          mountainCtl.options(available.length ? options : { '(no saved mountains)': '' });
          mountainCtl.updateDisplay();
          mountainCtl.enable(available.length > 0);
          openCtl.enable(available.length > 0);
          showLocation();
        };
        sourceCtl.onChange(fillMountains);
        mountainCtl.onChange(() => {
          remembered.set(state.source, state.project);
          showLocation();
        });
        fillMountains();
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
      if (!open) {
        toast('History needs an open workspace mountain.', 'info');
        return;
      }
      let listing: CheckpointListing;
      try {
        listing = await listCheckpoints();
      } catch (error) {
        log(`checkpoint list failed: ${error instanceof Error ? error.message : error}`);
        toast('Could not read this mountain’s history.', 'err');
        return;
      }
      const { checkpoints, budget } = listing;
      // What has changed since the newest checkpoint, read before the panel is built because it also names
      // who the room credits registers to — the people a scoped revert may be aimed at. A failure here costs
      // the summary, never the panel.
      const opening = checkpoints.length ? await checkpointChanges(checkpoints[0].file).catch(() => null) : null;
      const { host, close } = modal();
      let closed = false;
      const dismiss = () => {
        if (!closed) {
          closed = true;
          close();
        }
      };
      const g = new GUI({ container: host, title: `History — ${open.name}` });
      banner(host, HISTORY_NOTE, 'info').appendChild(infoBadge(HISTORY_DETAIL));
      if (budget.dropped) banner(host, budgetNote(budget), 'warn');
      if (!checkpoints.length) {
        banner(
          host,
          `${open.name} holds no checkpoints yet — one is taken after a few minutes of real editing, ` +
            'or now, under a note, with the button below.',
          'info',
        );
      }
      const state = { note: '', checkpoint: checkpoints[0]?.file ?? '' };
      const chosen = () => checkpoints.find(candidate => candidate.file === state.checkpoint)!;
      /**
       * The outcomes every action shares. A checkpoint that has been thinned since this listing was read is not
       * a failure the author can act on — the row was valid when it was offered — so the panel reopens on the
       * list as it now stands instead of reporting a missing file.
       */
      const act = async (what: string, run: () => Promise<void>) => {
        try {
          await run();
        } catch (error) {
          if (error instanceof CheckpointGoneError) {
            dismiss();
            toast(
              'That checkpoint was thinned while History was open — here is the list as it stands now.',
              'info',
              7000,
            );
            historyDialog();
            return;
          }
          log(`could not ${what}: ${error instanceof Error ? error.message : error}`);
          toast(`Could not ${what}.`, 'err', 6000);
        }
      };
      tip(g.add(state, 'note').name('note'), 'A note to find this moment by — “before I redid the finish area”.');
      tip(
        g
          .add(
            {
              take: () =>
                void act('save a named checkpoint', async () => {
                  const note = state.note.trim();
                  if (!note) {
                    toast('Write the note first — it is what the checkpoint is found by later.', 'info', 5000);
                    return;
                  }
                  await checkpointNow(note);
                  dismiss();
                  toast(`Saved “${note}” — ${open.name} as it stands now, kept for good.`, 'ok', 6000);
                }),
            },
            'take',
          )
          .name('Save a named checkpoint'),
        'Set the mountain aside as it stands now, kept for good.',
        'Unsaved edits are written first, and a named checkpoint is kept whatever the thinning schedule does.',
      );
      if (checkpoints.length) {
        const options: Record<string, string> = {};
        for (const checkpoint of checkpoints) options[checkpointLabel(checkpoint)] = checkpoint.file;
        // What has changed since the selected checkpoint. Read off the register model on the server, so
        // choosing between checkpoints costs a sentence rather than a download each.
        const changed = {
          summary: opening ? describeCheckpointChanges(opening) : 'reading…',
          who: ANYONE,
          scope: 'map' as 'map' | 'selection',
        };
        let changedCtl: Controller | null = null;
        const refreshChanges = () => {
          changed.summary = 'reading…';
          changedCtl?.updateDisplay();
          const asked = state.checkpoint;
          void checkpointChanges(asked)
            .then(answer => {
              if (closed || state.checkpoint !== asked) return;
              changed.summary = describeCheckpointChanges(answer);
              changedCtl?.updateDisplay();
            })
            .catch(error => {
              if (closed || state.checkpoint !== asked) return;
              changed.summary = `could not read what changed: ${error instanceof Error ? error.message : error}`;
              changedCtl?.updateDisplay();
            });
        };
        tip(
          g.add(state, 'checkpoint', options).name(`checkpoint (now r${open.revision})`).onChange(refreshChanges),
          'Newest first: age, time, the revision it holds, its size, and what it was taken for.',
        );
        changedCtl = tip(
          g.add(changed, 'summary').name('what changed since').disable(),
          'How this map differs from the selected checkpoint.',
          'Counted register by register: corners moved, faces repainted or retextured, objects that appeared ' +
            'or vanished, globals that differ. This is what tells you which checkpoint you actually want.',
        );
        tip(
          g
            .add(
              {
                compare: () =>
                  void act('compare that checkpoint', async () => {
                    const checkpoint = chosen();
                    const document = await readCheckpoint(checkpoint.file);
                    compareCheckpoint(document, `checkpoint r${checkpoint.revision}`);
                    dismiss();
                    toast(
                      `${checkpointLabel(checkpoint)} is in the reference slot — Scene ▸ Reference moves it off the ` +
                        'live mountain. The mountain is untouched.',
                      'info',
                      9000,
                    );
                  }),
              },
              'compare',
            )
            .name('Compare beside the live mountain'),
          'Load this checkpoint into the reference slot; nothing about the mountain changes.',
        );
        tip(
          g
            .add(
              {
                preview: () =>
                  void act('preview that checkpoint', async () => {
                    const checkpoint = chosen();
                    const document = await readCheckpoint(checkpoint.file);
                    await beginPreview(); // autosave is held from here, so nothing the preview renders reaches the project
                    dismiss();
                    await adoptDocument(document);
                    toast(
                      `Previewing ${checkpointLabel(checkpoint)} — the mountain is untouched. ` +
                        'File ▸ Close preview returns to it.',
                      'info',
                      9000,
                    );
                  }),
              },
              'preview',
            )
            .name('Preview'),
          'Open this checkpoint read-only; autosave is held, so nothing can be written back.',
        );
        tip(
          g
            .add(
              {
                restore: () =>
                  void act('restore that checkpoint', async () => {
                    const checkpoint = chosen();
                    const outcome = await restoreCheckpoint(checkpoint.file);
                    dismiss();
                    // Identical to what the project already holds: no revision was written, and saying so is the honest
                    // answer — a button that reports a restore nothing came of is the one that looks broken.
                    if (outcome.unchanged) {
                      toast(
                        `${checkpointLabel(checkpoint)} is already exactly what ${open.name} holds — nothing to restore.`,
                        'info',
                        7000,
                      );
                      return;
                    }
                    await adoptDocument(outcome.document);
                    toast(
                      `Restored ${checkpointLabel(checkpoint)} as revision ${currentProject()?.revision ?? '?'}.`,
                      'ok',
                      6000,
                    );
                  }),
              },
              'restore',
            )
            .name('Restore'),
          'Make this checkpoint the mountain’s newest revision.',
          'The revision counter moves forward, and the document being replaced is checkpointed first and kept ' +
            '— so a restore can itself be undone.',
        );
        tip(
          g
            .add(
              {
                fork: () =>
                  void act('fork that checkpoint', async () => {
                    const checkpoint = chosen();
                    const document = await readCheckpoint(checkpoint.file);
                    dismiss();
                    if (!(await installDocument(document, true))) return;
                    toast(
                      `Forked ${checkpointLabel(checkpoint)} into its own mountain — ${open.name} is untouched.`,
                      'ok',
                      6000,
                    );
                  }),
              },
              'fork',
            )
            .name('Fork to a new mountain'),
          'Save this checkpoint as a separate mountain and switch to it.',
        );
        tip(
          g
            .add(
              {
                export: () =>
                  void act('export that checkpoint', async () => {
                    const checkpoint = chosen();
                    const bundle = await exportCheckpoint(checkpoint.file);
                    mountainExportResult(
                      bundle,
                      downloadMountainBundle(bundle, { filenameStem: open.name, checkpoint: true }),
                    );
                  }),
              },
              'export',
            )
            .name('Export as mountain…'),
          'Download this revision as a portable .slopesmith.zip; importing it creates a new mountain.',
        );
        tip(
          g
            .add(
              {
                name: () =>
                  void act('name that checkpoint', async () => {
                    const note = state.note.trim();
                    if (!note) {
                      toast('Write the note first — it is what the checkpoint is found by later.', 'info', 5000);
                      return;
                    }
                    await nameCheckpoint(chosen().file, note);
                    dismiss();
                    toast(`Named “${note}” — that checkpoint is kept from now on.`, 'ok', 6000);
                  }),
              },
              'name',
            )
            .name('Name the selected checkpoint'),
          'Give the selected checkpoint that note; a named checkpoint is never thinned.',
        );

        // ---- putting part of it back (docs/040) ----
        // Whole-document restore is blunt in a shared session: rolling an hour back to undo one person's
        // mistake discards everyone else's good work from that hour. A scoped revert assigns the checkpoint's
        // values to exactly the registers named, which is an ordinary edit and travels the ordinary path.
        if (isWritable()) {
          // Whoever the room credits a register to, plus the members each checkpoint records — so somebody who
          // wrote before the room was reopened can still be named.
          const who = [
            ...new Set([...(opening?.writers ?? []), ...checkpoints.flatMap(entry => entry.members)]),
          ].sort();
          const revert = g.addFolder('Revert part of the map');
          tip(
            revert.add(changed, 'who', [ANYONE, ...who]).name('whose work'),
            'Revert only the registers this person last changed.',
            'Anyone else’s work on the same map is left exactly where it is. A value they changed and somebody ' +
              'else changed after them belongs to the later writer and stays.',
          );
          tip(
            revert
              .add(changed, 'scope', { 'the whole map': 'map', 'the current selection': 'selection' })
              .name('how far'),
            'The whole map, or only the corners and faces selected right now.',
            'Creases follow when both of their corners are selected. A revert puts values back and never ' +
              'brings back geometry somebody deleted — Restore is what does that.',
          );
          tip(
            revert
              .add(
                {
                  run: () =>
                    void act('revert to that checkpoint', async () => {
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
                        toast(
                          `Nothing to revert — ${describeScope(changed.who, !!selection)} already matches ` +
                            `${checkpointLabel(checkpoint)}.`,
                          'info',
                          7000,
                        );
                        return;
                      }
                      await adoptDocument(outcome.document);
                      toast(
                        `Reverted ${describeScope(changed.who, !!selection)} to ${checkpointLabel(checkpoint)} — ` +
                          `${outcome.reverted} registers put back as revision ${currentProject()?.revision ?? '?'}. ` +
                          'The document it replaced is kept, so this is undone the same way a restore is.',
                        'ok',
                        9000,
                      );
                    }),
                },
                'run',
              )
              .name('Revert'),
            'Assign the checkpoint’s values to the registers this scope names.',
            'Everybody on the map is pushed them as ordinary registers, and the document being replaced is ' +
              'checkpointed and kept first.',
          );
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
    if (!conflict) {
      toast('This mountain is not in conflict.', 'info');
      return;
    }
    const { host, close } = modal();
    const g = new GUI({ container: host, title: 'Mountain changed elsewhere' });
    banner(
      host,
      `${conflict.project.name} is at revision ${conflict.project.revision} on disk — another ` +
        'editor saved it while this tab was editing, so this tab’s changes were refused and autosave has ' +
        'stopped. Nothing is lost yet, and saving yours as a new mountain keeps both documents.',
      'warn',
    );
    const act = async (what: string, run: () => Promise<void>) => {
      close();
      try {
        await run();
      } catch (error) {
        log(`could not ${what}: ${error instanceof Error ? error.message : error}`);
        toast(`Could not ${what} — the conflict stands; reopen it from File ▸ Resolve conflict….`, 'err', 8000);
      }
    };
    tip(
      g
        .add(
          {
            mine: () =>
              void act('save your document', async () => {
                await keepMine();
                if (!getConflict()) toast('Your document was saved over the one on disk.', 'ok');
              }),
          },
          'mine',
        )
        .name('Keep mine'),
      'Save this tab’s document over the one on disk; the other save stays in history as a checkpoint.',
    );
    tip(
      g
        .add(
          {
            theirs: () =>
              void act('open the saved mountain', async () => {
                await adoptDocument(await takeTheirs());
                toast('Opened the mountain as it stands on disk.', 'ok');
              }),
          },
          'theirs',
        )
        .name('Take theirs'),
      'Discard this tab’s unsaved changes and open the mountain as saved; undo history resets.',
    );
    const fork = g
      .add(
        {
          fork: () =>
            void act('create the mountain', async () => {
              await saveMineAsNewProject();
              toast(`Saved as a new mountain — ${conflict.project.name} keeps the other editor’s save.`, 'ok', 6000);
            }),
        },
        'fork',
      )
      .name('Save mine as a new mountain');
    if (!canCreateMountains()) fork.disable();
    tip(
      fork,
      canCreateMountains()
        ? 'Keep both: this tab’s document becomes a mountain of its own and the editor follows it there.'
        : 'Creating the second mountain requires the editor role.',
    );
    tip(
      g.add({ later: close }, 'later').name('Decide later'),
      'Leave the conflict standing. Autosave stays stopped until you choose; File ▸ Resolve conflict… reopens this.',
    );
  }

  /** Choose an editable Slopesmith mountain or a compiled-map input archive for Snowknife. */
  function exportDialog() {
    const d = getDoc();
    const { host, close } = modal();
    host.classList.add('sp-export-modal');
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-label', 'Export');
    host.setAttribute('aria-modal', 'true');

    const title = document.createElement('h3');
    title.textContent = `Export — ${d.name}`;
    const label = document.createElement('label');
    label.textContent = 'Export for';
    const purpose = document.createElement('select');
    purpose.setAttribute('aria-label', 'Export for');
    purpose.add(new Option('Another Slopesmith instance', 'slopesmith'));
    purpose.add(new Option('Snowknife — Custom ISO', 'snowknife-iso'));
    purpose.add(new Option('Snowknife — Mod Manager', 'snowknife-mod-manager'));
    label.appendChild(purpose);
    const description = document.createElement('p');
    description.className = 'sp-modal-note';
    const commands = createSnowknifeCommands(exportFolderName(d));
    const actions = document.createElement('div');
    actions.className = 'sp-modal-actions';
    const cancel = document.createElement('button');
    cancel.className = 'sp-btn';
    cancel.textContent = 'Cancel';
    cancel.onclick = close;
    const go = document.createElement('button');
    go.className = 'sp-btn accent';
    go.onclick = () => {
      const snowknife = snowknifeTarget(purpose.value) !== null;
      close();
      if (snowknife) void runExport(d);
      else void exportMountain();
    };
    actions.append(cancel, go);
    host.append(title, label, description, commands.element, actions);
    purpose.onchange = updatePurpose;
    updatePurpose();
    purpose.focus();

    function updatePurpose() {
      const target = snowknifeTarget(purpose.value);
      const snowknife = target !== null;
      commands.setTarget(target);
      go.textContent = snowknife ? 'Download .snowknife.zip' : 'Download .slopesmith.zip';
      description.textContent = snowknife
        ? `Downloads ${exportFolderName(d)}.snowknife.zip. Use Snowknife locally to build ${target === 'iso' ? 'a custom PS2 Tricky ISO' : 'a ZIP for SSX Mod Manager'}.`
        : 'Download an editable .slopesmith.zip mountain with its custom assets. On another Slopesmith instance, choose Load map → Import from file to continue editing.';
    }
  }

  /** Compose and download the Snowknife map archive entirely in the browser. */
  async function runExport(d: EditDoc) {
    const target = resolveExportTarget(d);
    toast(`Exporting ${d.name}…`, 'info', 0);
    try {
      const result = await exportMapFolder(d, target);
      toast(`✓ Exported ${d.name} → ${result.destination}`, 'ok', 6000);
      log(`${result.destination}\n\n${result.log}`);
    } catch (e) {
      toast('Export failed — see details', 'err');
      log(`EXPORT FAILED\n${e instanceof Error ? (e.stack ?? e.message) : e}`);
    }
  }

  return {
    assetMigrationDialog: () => {
      void showAssetMigration({
        getDoc,
        setDoc: deps.setDoc,
        isWritable: deps.isWritable,
        checkpoint: () => deps.checkpointNow('Before migrating asset references', 'bulk'),
        reload: deps.loadMountain,
      });
    },
    newMountainDialog,
    buildFromReferenceCourseDialog,
    openProjectDialog,
    historyDialog,
    closePreview,
    conflictDialog,
    renameMountain,
    duplicateMountain,
    deleteMountain,
    exportMountain,
    exportDialog,
  };
}

export type Dialogs = ReturnType<typeof createDialogs>;
