import { migrateMountain } from '../../../core/doc/mountain';
import {
  DEFAULT_RETOPOLOGY_OPTIONS,
  type RetopologyCapabilities,
  type RetopologyJobOptions,
  type RetopologyJobResult,
  type RetopologyScope,
  type RetopologyStrategy,
  type RetopologyJobStatus,
} from '../../../core/mesh/retopology/job-contract';
import {
  conformRetopologySeams, type ConformedRetopology, type ConformRetopologyOptions,
} from '../../../core/mesh/retopology/conform';
import { detail, errorBanner, note, tip, warningBanner } from '../components/gui';
import { toast } from '../components/toast';
import { buildTrailIntegrationGuide } from './trail-guide';
import type { ToolsContext } from './widgets';

const terminal = (phase: RetopologyJobStatus['phase']): boolean =>
  phase === 'complete' || phase === 'failed' || phase === 'cancelled';

async function responseError(response: Response): Promise<string> {
  try {
    const value = await response.json() as { error?: string };
    if (value.error) return value.error;
  } catch { /* a plain-text proxy error falls through */ }
  return `${response.status} ${response.statusText}`;
}

/** The Edit toolbox's long-running native retopology workflow. State lives outside the rebuilt lil-gui tree,
 * so changing a progress phase or selection cannot lose a running job or its completed preview. */
export function createRetopologyTools(ctx: ToolsContext) {
  const { store, editSection, rebuildTools } = ctx;
  let opened = false;
  let workflow: 'quadwild' | 'conform-seam' = 'quadwild';
  let capabilities: RetopologyCapabilities | null = null;
  let capabilitiesError = '';
  let loadingCapabilities = false;
  let status: RetopologyJobStatus | null = null;
  let selectedQuadIds: string[] = [];
  let sourceJson = '';
  let pollTimer = 0;
  let applying = false;
  const options: RetopologyJobOptions = { ...DEFAULT_RETOPOLOGY_OPTIONS };
  const conformOptions: ConformRetopologyOptions = { collarRings: 1, footprintResolution: 5 };
  let conformSourceJson = '';
  let conformResult: ConformedRetopology | null = null;
  let conformError = '';
  let conformRunning = false;

  const lockedCount = () => Object.keys(store.mdoc.quadLocked ?? {})
    .filter(key => store.mdoc.quadLocked?.[Number(key)] === true).length;

  function refresh(): void { if (opened) rebuildTools(); }

  async function loadCapabilities(): Promise<void> {
    if (capabilities || loadingCapabilities) return;
    loadingCapabilities = true;
    try {
      const response = await fetch('/api/retopology/capabilities', { cache: 'no-store' });
      if (!response.ok) throw new Error(await responseError(response));
      capabilities = await response.json() as RetopologyCapabilities;
      const requestedScope = options.scope;
      Object.assign(options, capabilities.defaults, {
        targetPatchSizeM: store.mdoc.spacing || capabilities.defaults.targetPatchSizeM,
        scope: requestedScope,
      });
    } catch (error) {
      capabilitiesError = error instanceof Error ? error.message : String(error);
    } finally {
      loadingCapabilities = false;
      refresh();
    }
  }

  function open(scope: RetopologyScope = 'whole-unlocked'): void {
    if (!status) {
      options.scope = scope;
      selectedQuadIds = scope === 'selected-region' ? [...store.cellSel] : [];
    }
    workflow = 'quadwild';
    opened = true;
    void loadCapabilities();
    rebuildTools();
  }

  function openConform(): void {
    workflow = 'conform-seam';
    opened = true;
    rebuildTools();
  }

  function close(): void {
    opened = false;
    rebuildTools();
  }

  function schedulePoll(id: string): void {
    clearTimeout(pollTimer);
    pollTimer = window.setTimeout(() => void poll(id), 750);
  }

  async function poll(id: string): Promise<void> {
    if (status?.id !== id || terminal(status.phase)) return;
    try {
      const response = await fetch(`/api/retopology/jobs/${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(await responseError(response));
      status = await response.json() as RetopologyJobStatus;
      refresh();
      if (!terminal(status.phase)) schedulePoll(id);
    } catch (error) {
      status = {
        ...status,
        phase: 'failed',
        detail: 'Could not read job progress',
        error: error instanceof Error ? error.message : String(error),
      };
      refresh();
    }
  }

  async function run(): Promise<void> {
    if (status && !terminal(status.phase)) return;
    if (!ctx.retopology.isWritable()) {
      toast('This project is read-only.', 'warn');
      return;
    }
    if (options.scope === 'whole-unlocked' && !lockedCount()) {
      toast('Lock the trail or another connected terrain feature first.', 'warn', 6000);
      return;
    }
    if (options.scope === 'selected-region' && !selectedQuadIds.length) {
      toast('Select one connected patch region first.', 'warn', 6000);
      return;
    }
    sourceJson = JSON.stringify(store.mdoc);
    status = {
      id: '', phase: 'preparing', progress: 1, detail: 'Sending the mountain snapshot',
      createdAt: new Date().toISOString(),
    };
    refresh();
    try {
      const response = await fetch('/api/retopology/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          document: JSON.parse(sourceJson), options,
          ...(options.scope === 'selected-region' ? { selectedQuadIds } : {}),
        }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      status = await response.json() as RetopologyJobStatus;
      refresh();
      schedulePoll(status.id);
    } catch (error) {
      status = {
        ...status,
        phase: 'failed', detail: 'Could not start retopology',
        error: error instanceof Error ? error.message : String(error),
      };
      refresh();
    }
  }

  async function cancel(): Promise<void> {
    if (!status?.id || terminal(status.phase)) return;
    const id = status.id;
    clearTimeout(pollTimer);
    try {
      const response = await fetch(`/api/retopology/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(await responseError(response));
      status = await response.json() as RetopologyJobStatus;
    } catch (error) {
      toast(`Could not cancel: ${error instanceof Error ? error.message : error}`, 'err');
    }
    refresh();
  }

  async function apply(): Promise<void> {
    if (applying || status?.phase !== 'complete') return;
    if (JSON.stringify(store.mdoc) !== sourceJson) {
      toast('The mountain changed while this job ran. Discard it and run again from the current terrain.', 'warn', 8000);
      return;
    }
    applying = true;
    refresh();
    try {
      const response = await fetch(`/api/retopology/jobs/${encodeURIComponent(status.id)}/result`, { cache: 'no-store' });
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json() as RetopologyJobResult;
      await ctx.retopology.apply(migrateMountain(result.document));
      const count = result.summary.totalPatches;
      opened = false;
      status = null;
      sourceJson = '';
      toast(`Retopology applied · ${count.toLocaleString()} connected patches`, 'ok', 7000);
    } catch (error) {
      toast(`Could not apply retopology: ${error instanceof Error ? error.message : error}`, 'err', 8000);
    } finally {
      applying = false;
      refresh();
    }
  }

  function discard(): void {
    if (status && !terminal(status.phase)) return;
    status = null;
    sourceJson = '';
    rebuildTools();
  }

  async function runConform(): Promise<void> {
    if (conformRunning) return;
    if (!ctx.retopology.isWritable()) { toast('This project is read-only.', 'warn'); return; }
    if (!lockedCount()) { toast('Lock the trail or feature whose seam should be conformed first.', 'warn', 6000); return; }
    if (!(store.mdoc.tJunctions?.length)) { toast('This mountain has no recorded T-junction seam.', 'warn', 6000); return; }
    conformSourceJson = JSON.stringify(store.mdoc);
    conformResult = null; conformError = ''; conformRunning = true; refresh();
    // Let lil-gui paint the working state before the bounded local topology solve begins.
    await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    try {
      conformResult = conformRetopologySeams(JSON.parse(conformSourceJson), conformOptions);
    } catch (error) {
      conformError = error instanceof Error ? error.message : String(error);
    } finally {
      conformRunning = false; refresh();
    }
  }

  async function applyConform(): Promise<void> {
    if (applying || !conformResult) return;
    if (JSON.stringify(store.mdoc) !== conformSourceJson) {
      toast('The mountain changed while this result was built. Discard it and run again.', 'warn', 8000);
      return;
    }
    applying = true; refresh();
    try {
      await ctx.retopology.apply(conformResult.document);
      const report = conformResult.report;
      toast(`Conforming seam applied · ${report.removedTJunctions} T-junctions removed`, 'ok', 7000);
      opened = false; conformResult = null; conformSourceJson = ''; conformError = '';
      rebuildTools();
    } catch (error) {
      toast(`Could not apply conforming seam: ${error instanceof Error ? error.message : error}`, 'err', 8000);
    } finally {
      applying = false; refresh();
    }
  }

  function discardConform(): void {
    conformResult = null; conformSourceJson = ''; conformError = ''; rebuildTools();
  }

  function buildLauncher(): void {
    const section = editSection('retopology-launcher', 'Retopology', false);
    note(section, 'Rebuild the whole mountain’s unlocked topology around exact locked trails and terrain.');
    const launch = tip(section.add({ open: () => open('whole-unlocked') }, 'open').name('▦ retopologize…'),
      'Open the retopology options. Locked patches remain exact and are integrated into one connected result.');
    if (store.modelEditId) launch.disable();
    const conform = tip(section.add({ conform: openConform }, 'conform').name('◇ make seam conforming…'),
      'Locally replace an existing T-junction collar with shared quad topology. Locked patches and terrain outside the collar stay exact.');
    if (store.modelEditId || !(store.mdoc.tJunctions?.length)) conform.disable();
  }

  function buildConform(): void {
    const intro = editSection('retopology-conform-intro', 'Make Seam Conforming');
    warningBanner(intro, 'Lock every trail or feature patch that must remain exact. Only the unlocked collar around a recorded T-junction seam is rebuilt.');
    note(intro, 'Local operation — no QuadWild server job. It replaces the old T-node interface with shared edges and ordinary 3/5-pole transitions.');
    detail(intro, `${(store.mdoc.tJunctions?.length ?? 0).toLocaleString()}`, 'recorded T-junctions');
    detail(intro, `${lockedCount().toLocaleString()}`, 'locked exact patches');

    if (!conformResult) {
      const geometry = editSection('retopology-conform-geometry', 'Geometry');
      tip(geometry.add(conformOptions, 'collarRings', 1, 3, 1).name('collar rings'),
        'Unlocked rings replaced around the old seam. Start with 1; use more only when the immediate collar is badly pinched.');
      note(geometry, 'The result maximizes quads. A collapsed-edge wedge is allowed only when loop parity or local geometry requires it.');
      if (conformError) errorBanner(geometry, conformError);
      const actions = editSection('retopology-conform-actions', 'Actions');
      const runControl = tip(actions.add({ run: () => void runConform() }, 'run')
        .name(conformRunning ? 'building result…' : '▶ build conforming result'),
      'Build and validate a replacement collar without changing the live mountain.');
      if (conformRunning || !ctx.retopology.isWritable() || !lockedCount() || !(store.mdoc.tJunctions?.length)) runControl.disable();
      tip(actions.add({ back: close }, 'back').name('← back'), 'Close without changing the mountain.');
      return;
    }

    const report = conformResult.report;
    const result = editSection('retopology-conform-result', 'Validated Result Ready');
    detail(result, `${report.removedTJunctions} removed / ${report.remainingTJunctions} remain`, 'T-junctions');
    detail(result, `${report.removedPatches} → ${report.rebuiltPatches}`, 'collar patches');
    detail(result, `${report.wedges}`, 'triangle wedges');
    detail(result, `${report.extraordinaryPoles}`, 'extraordinary poles (surface total)');
    detail(result, `${report.invertedPatches}`, 'inverted new patches');
    detail(result, `${report.maximumAspectRatio.toFixed(2)}`, 'worst new aspect');
    detail(result, `${report.connectedComponents}`, 'components');
    detail(result, `${report.maximumLockedControlDeviationM.toFixed(6)} m`, 'locked control change');
    detail(result, `${report.maximumRetainedControlDeviationM.toFixed(6)} m`, 'outside control change');
    if (report.maximumAspectRatio > 8) warningBanner(result,
      'The result contains at least one stretched collar patch. Inspect the seam after Apply; Undo remains available.');
    const actions = editSection('retopology-conform-actions', 'Actions');
    const applyControl = tip(actions.add({ apply: () => void applyConform() }, 'apply')
      .name(applying ? 'applying…' : '✔ apply conforming seam'),
    'Create one undoable bulk checkpoint and replace the old T-junction collar atomically.');
    if (applying || !ctx.retopology.isWritable()) applyControl.disable();
    tip(actions.add({ discard: discardConform }, 'discard').name('discard result'), 'Forget this result without changing the mountain.');
  }

  function build(): void {
    if (workflow === 'conform-seam') { buildConform(); return; }
    const intro = editSection('retopology-intro', 'Retopologize');
    warningBanner(intro, 'Before running: lock every patch you do not want changed. Retopology rebuilds all unlocked patches in scope.');
    note(intro, options.scope === 'selected-region'
      ? 'Selected region — freeze everything outside'
      : 'Whole mountain — preserve every locked region');
    detail(intro, `${store.mdoc.quads.length.toLocaleString()}`, 'source patches');
    if (options.scope === 'selected-region') detail(intro, `${selectedQuadIds.length.toLocaleString()}`, 'selected patches');
    detail(intro, `${lockedCount().toLocaleString()}`, 'locked exact');

    const strategyEntry = (id: RetopologyStrategy) => capabilities?.strategies?.find(entry => entry.id === id);
    if (loadingCapabilities) detail(intro, 'checking server…', 'strategies');
    else if (capabilitiesError) errorBanner(intro, capabilitiesError);
    else if (capabilities && !capabilities.available) errorBanner(intro, capabilities.reason ?? 'No retopology strategy is available');
    else if (capabilities) {
      const quadwild = strategyEntry('quadwild');
      detail(intro, quadwild?.available
        ? `ready · ${capabilities.concurrency} job${capabilities.concurrency === 1 ? '' : 's'} at once`
        : 'not installed on this server', 'QuadWild');
      detail(intro, 'built in', 'Elevation loops');
    }

    const running = !!status && !terminal(status.phase);
    if (!status) {
      const geometry = editSection('retopology-geometry', 'Geometry');
      const scopes: Record<string, RetopologyScope> = { 'Whole mountain — preserve all locks': 'whole-unlocked' };
      if (selectedQuadIds.length) scopes['Selected region — freeze outside'] = 'selected-region';
      geometry.add(options, 'scope', scopes).name('scope').onChange(() => rebuildTools());
      const quadwild = strategyEntry('quadwild');
      const strategies: Record<string, RetopologyStrategy> = {
        [`QuadWild — native global solver${quadwild && !quadwild.available ? ' (not installed)' : ''}`]: 'quadwild',
        [`Elevation loops — contour flow${options.scope === 'selected-region' ? ' (whole mountain only)' : ''}`]: 'contour-flow',
      };
      tip(geometry.add(options, 'strategy', strategies).name('strategy').onChange(() => rebuildTools()),
        'How the new topology is generated.',
        'QuadWild solves a global cross-field; Elevation loops sweeps edge loops along graded contours. An '
        + 'unavailable or incompatible selection is rejected, never silently replaced.');
      const selectedStrategy = strategyEntry(options.strategy);
      if (selectedStrategy && !selectedStrategy.available) {
        errorBanner(geometry, selectedStrategy.reason ?? 'The selected retopology strategy is unavailable.');
      } else if (selectedStrategy && !selectedStrategy.scopes.includes(options.scope)) {
        errorBanner(geometry, options.strategy === 'contour-flow'
          ? 'Elevation loops only supports whole-mountain retopology. Choose QuadWild for a selected region.'
          : 'The selected retopology strategy does not support this scope.');
      }
      const influence = tip(geometry.add(options, 'influenceRings', 0, 5, 1).name('influence rings'),
        'Grow the selected solve through this many neighboring patch rings before freezing its exact outer boundary.');
      if (options.scope !== 'selected-region') influence.disable();
      tip(geometry.add(options, 'targetPatchSizeM', 2, 100, .5).name('target patch size (m)'),
        'Desired control-patch scale. This directly drives generated cage density and is independent of render tessellation.');
      if (options.strategy === 'quadwild') {
        tip(geometry.add(options, 'quadWildScale', .5, 4, .05).name('density calibration'),
          'Advanced multiplier around the target size. The validated calibration is 1.6; larger values make larger, fewer patches.');
      }
      tip(geometry.add(options, 'preserveSurfacePaint').name('preserve surface + paint'),
        'Project each generated patch from the nearest replaced source patch while keeping locked patch paint exact.');

      const validation = editSection('retopology-validation', 'Validation');
      tip(validation.add(options, 'maximumSurfaceDeviationM', .1, 100, .5).name('maximum deviation (m)'),
        'Reject the job instead of offering Apply when its worst sampled bicubic surface error exceeds this limit.');
      tip(validation.add(options, 'qualityResolution', { Standard: 4, Fast: 2, High: 6 }).name('surface sampling'),
        'Samples per bicubic patch axis during restoration and final surface-deviation validation.');

      const actions = editSection('retopology-actions', 'Actions');
      const start = tip(actions.add({ run: () => void run() }, 'run').name('▶ run retopology job'),
        'Run the selected strategy; nothing changes until a validated result is applied.');
      const targetReady = options.scope === 'selected-region' ? selectedQuadIds.length > 0 : lockedCount() > 0;
      if (!ctx.retopology.isWritable() || !targetReady) start.disable();
      tip(actions.add({ back: close }, 'back').name('← back'), 'Close these options without changing the mountain.');
      // Retopology is the last step of the trail workflow, and this is the state that runs it — so the
      // sequence is here, where the lock the banner above demands can still be gone back and made.
      buildTrailIntegrationGuide(editSection);
      return;
    }

    const progress = editSection('retopology-progress', status.phase === 'complete' ? 'Validated Result Ready' : 'Job');
    detail(progress, `${Math.round(status.progress)}%`, 'progress');
    detail(progress, status.detail, 'phase');
    if (status.queuePosition) detail(progress, `${status.queuePosition}`, 'queue position');
    if (status.error) errorBanner(progress, status.error);

    const summary = status.summary;
    if (summary) {
      const result = editSection('retopology-result', 'Validated Result');
      detail(result, `${summary.protectedPatches.toLocaleString()} frozen + ${summary.generatedPatches.toLocaleString()} generated`, 'patches');
      detail(result, `${summary.lockedPatches.toLocaleString()}`, 'locked exact');
      detail(result, `${summary.remeshedSourcePatches.toLocaleString()}`, 'source patches rebuilt');
      detail(result, `${summary.interfaceEdges.protected} ↔ ${summary.interfaceEdges.generated}`, 'locked interface');
      detail(result, `${summary.connectedComponents}`, 'components');
      detail(result, `${summary.tJunctions}`, 'T-junctions');
      detail(result, `${summary.invertedPatches}`, 'inverted');
      detail(result, `${summary.cageEdgeLengthM.median.toFixed(1)} / ${summary.cageEdgeLengthM.p95.toFixed(1)} m`, 'edge median / p95');
      detail(result, `${summary.cageAspectRatio.median.toFixed(2)} / ${summary.cageAspectRatio.p95.toFixed(2)}`, 'aspect median / p95');
      detail(result, `${summary.surfaceDeviationM.sourceToResult.p95?.toFixed(2) ?? '—'} / ${summary.surfaceDeviationM.symmetricMax?.toFixed(2) ?? '—'} m`, 'surface p95 / max');
    }

    const actions = editSection('retopology-actions', 'Actions');
    if (running) {
      tip(actions.add({ cancel: () => void cancel() }, 'cancel').name('cancel job'),
        'Stop the active QuadWild process. The live mountain remains unchanged.');
      tip(actions.add({ close }, 'close').name('close panel'), 'The server job keeps running; reopen Retopology to see it.');
    } else if (status.phase === 'complete') {
      const applyControl = tip(actions.add({ apply: () => void apply() }, 'apply').name(applying ? 'applying…' : '✔ apply retopology'),
        'Create a bulk-edit checkpoint, replace the topology atomically, and keep the operation undoable.');
      if (applying || !ctx.retopology.isWritable()) applyControl.disable();
      tip(actions.add({ discard }, 'discard').name('discard result'), 'Forget this preview without changing the mountain.');
    } else {
      tip(actions.add({ retry: discard }, 'retry').name('change options + retry'), 'Return to the options with the live mountain unchanged.');
      tip(actions.add({ back: close }, 'back').name('← close'), 'Close Retopology.');
    }
  }

  return {
    isOpen: () => opened,
    openWhole: () => open('whole-unlocked'),
    openSelected: () => open('selected-region'),
    close, buildLauncher, build,
  };
}
