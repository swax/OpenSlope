import { encodeViewLink, parseViewLink, type ViewLink } from '../../core/view-link';
import type { SharedViewOptions } from '../../core/session/screen-share';
import type { EditDoc } from '../../core/doc/doc-edit';
import type { Viewport, Mode } from '../viewport/viewport';
import { captureProgress } from '../state/capture-progress';

export interface BrowserViewDeps {
  viewport: Viewport;
  getDoc(): EditDoc;
  getProject(): { id: string; name: string; revision: number } | null;
  getMode(): Mode;
  getOptions(): SharedViewOptions;
  prepare(view: ViewLink): Promise<void>;
  showCamera(): void;
  building(): boolean;
  buildError(): string | null;
  buildSequence(): number;
}

/** Public browser workflow: URLs in, labelled DOM status and a normal PNG download out. */
export function createBrowserViews(deps: BrowserViewDeps) {
  const { viewport } = deps;
  const status = document.createElement('div'); status.id = 'capture-status';
  status.setAttribute('role', 'status'); status.setAttribute('aria-label', 'Capture status');
  document.body.appendChild(status);
  const controls = document.createElement('div'); controls.id = 'capture-controls';
  const save = document.createElement('button'); save.textContent = 'Save screenshot';
  const show = document.createElement('button'); show.textContent = 'Show editor';
  controls.append(save, show); document.body.appendChild(controls);
  const reveal = () => { document.body.classList.remove('sp-capture-clean'); deps.showCamera(); };
  show.onclick = reveal;
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.body.classList.contains('sp-capture-clean')) {
      event.preventDefault(); event.stopImmediatePropagation(); reveal();
    }
  }, true);
  let booted = false, applying = false, active = false, error: string | null = null;
  let request: ViewLink | null = null, expectedPose = '', projectId = '';
  let requestNumber = 0, requestedHash = location.hash;
  let chain = Promise.resolve();
  let signature = '', changedFrame = 0, changedAt = 0;
  const rounded = (_key: string, value: unknown) => typeof value === 'number' ? Number(value.toFixed(5)) : value;
  const pose = () => JSON.stringify([viewport.serializeView(), deps.getOptions(), deps.getMode(), viewport.captureSize], rounded);
  const publish = (state: string, message: string) => {
    if (state === 'error') document.body.classList.remove('sp-capture-clean');
    const project = deps.getProject();
    status.dataset.state = state;
    status.dataset.projectId = project?.id ?? '';
    status.dataset.revision = String(project?.revision ?? '');
    status.dataset.request = requestedHash;
    status.dataset.frame = String(viewport.renderFrame);
    status.dataset.width = String(viewport.renderer.domElement.width);
    status.dataset.height = String(viewport.renderer.domElement.height);
    status.dataset.camera = JSON.stringify(viewport.serializeView());
    status.dataset.options = JSON.stringify(deps.getOptions());
    const text = `${message}${project ? ` · ${project.name} · revision ${project.revision}` : ''}`;
    if (status.textContent !== text) status.textContent = text;
    save.disabled = state !== 'ready';
  };
  function poll() {
    if (!active) return;
    const progress = captureProgress.snapshot();
    status.dataset.pending = JSON.stringify(progress.pending);
    status.dataset.errors = JSON.stringify(progress.errors);
    const project = deps.getProject();
    const next = JSON.stringify([pose(), project?.id, project?.revision, progress.generation, deps.buildSequence()]);
    if (signature !== next) { signature = next; changedFrame = viewport.renderFrame; changedAt = performance.now(); }
    if (error) return publish('error', error);
    if (!booted || applying || deps.building() || progress.pending.length)
      return publish('loading', `Preparing capture${progress.pending.length ? ` · ${progress.pending.length} assets loading` : ''}`);
    if (deps.buildError()) return publish('error', deps.buildError()!);
    if (!project || (projectId && project.id !== projectId)) return publish('error', 'The requested mountain is not open.');
    if (request?.revision !== undefined && request.revision !== project.revision)
      return publish('error', `Requested revision ${request.revision}; this tab has ${project.revision}. Obtain a new link for the current revision.`);
    if (progress.errors.length) return publish('error', `${progress.errors.length} scene assets failed: ${progress.errors[0].asset}`);
    if (expectedPose && pose() !== expectedPose) return publish('changed', 'View changed since this link was applied. Copy a new view link or reopen this one.');
    // A completed unchanged view can be captured from a background tab; captureScreenshot renders explicitly.
    if (viewport.renderFrame < changedFrame + 2 || performance.now() - changedAt < 200)
      return publish('loading', 'Waiting for the completed view');
    publish('ready', 'Capture ready');
  }
  async function applyRequest(sequence: number) {
    if (sequence !== requestNumber || !booted) return;
    applying = true; error = null; expectedPose = ''; signature = '';
    try {
      request = parseViewLink(requestedHash);
      active = !!request;
      document.body.classList.toggle('sp-view-link', active);
      if (!request) { document.body.classList.remove('sp-capture-clean'); viewport.setCaptureSize(null); return; }
      projectId = new URLSearchParams(location.search).get('project') ?? deps.getProject()?.id ?? '';
      if (projectId !== deps.getProject()?.id) throw new Error('The requested mountain could not be opened.');
      publish('loading', 'Preparing capture');
      await deps.prepare(request);
      if (sequence !== requestNumber) return;
      viewport.setCaptureSize(request.size ?? null);
      document.body.classList.toggle('sp-capture-clean', !request.ui);
      const origin = request.space === 'world' ? [0, 0, 0] : viewport.cameraMountainCentre(request.space === 'mountain' ? 'authored' : 'reference');
      if (!origin) throw new Error(`No ${request.space} terrain is available for these coordinates.`);
      const current = viewport.serializeView();
      viewport.applyView({ ...current, ortho: request.projection === 'orthographic', fov: request.fov,
        up: request.up ? [request.up[0], request.up[1], -request.up[2]] : [0, 1, 0],
        zoom: 1, orthoHalfH: (request.height ?? 200) / 2,
        ...(request.pos && request.look ? {
          pos: [request.pos[0] + origin[0], request.pos[1] + origin[1], -(request.pos[2] + origin[2])],
          target: [request.look[0] + origin[0], request.look[1] + origin[1], -(request.look[2] + origin[2])],
        } : {}),
      });
      if (!request.pos) {
        viewport.frameCamera(deps.getDoc(), request.label, request.az, request.el);
        if (request.up || (request.height && request.projection === 'orthographic'))
          viewport.applyView({ ...viewport.serializeView(),
            ...(request.up ? { up: [request.up[0], request.up[1], -request.up[2]] } : {}),
            ...(request.height && request.projection === 'orthographic' ? { zoom: 1, orthoHalfH: request.height / 2 } : {}),
          });
      }
      expectedPose = pose();
    } catch (e) {
      active = true; error = e instanceof Error ? e.message : String(e);
      document.body.classList.add('sp-view-link'); document.body.classList.remove('sp-capture-clean');
    } finally { applying = false; poll(); }
  }
  function navigate() {
    requestedHash = location.hash;
    const sequence = ++requestNumber;
    // Invalidate ready synchronously, including while an earlier reference request is finishing.
    expectedPose = ''; error = null; active = true; applying = true;
    publish('loading', 'Preparing capture');
    chain = chain.then(() => applyRequest(sequence));
  }
  window.addEventListener('hashchange', navigate);
  setInterval(poll, 100);
  save.onclick = async () => {
    poll(); if (status.dataset.state !== 'ready') return;
    save.disabled = true;
    try {
      const blob = await viewport.captureScreenshot();
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = `${deps.getProject()?.name ?? 'mountain'}-camera.png`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { error = String(e); }
    poll();
  };
  return {
    hasRequest() { try { return !!parseViewLink(location.hash); } catch { return true; } },
    booted() { booted = true; navigate(); },
    currentLink() {
      const project = deps.getProject();
      if (!project) throw new Error('Open a saved mountain to copy a view link.');
      const v = viewport.serializeView(), mode = deps.getMode();
      const ref = viewport.refLevelName;
      const url = new URL(location.href);
      const pixels = viewport.captureSize ?? [viewport.renderer.domElement.width, viewport.renderer.domElement.height];
      const scale = Math.min(1, 4096 / pixels[0], 4096 / pixels[1], Math.sqrt(8_388_608 / (pixels[0] * pixels[1])));
      const size: [number, number] = [Math.max(64, Math.floor(pixels[0] * scale)), Math.max(64, Math.floor(pixels[1] * scale))];
      url.search = new URLSearchParams({ project: project.id }).toString();
      url.hash = encodeViewLink({
        pos: [v.pos[0], v.pos[1], -v.pos[2]], look: [v.target[0], v.target[1], -v.target[2]],
        up: v.up ? [v.up[0], v.up[1], -v.up[2]] : [0, 1, 0], space: 'world',
        projection: v.ortho ? 'orthographic' : 'perspective', fov: v.fov ?? 55,
        ...(v.ortho ? { height: 2 * v.orthoHalfH / v.zoom } : {}),
        az: 45, el: 35, reference: ref && !ref.startsWith('(') ? ref : 'none',
        ...(ref && !ref.startsWith('(') ? { refOffset: viewport.referenceOffset() } : {}),
        mode: mode === 'info' ? 'scene' : mode === 'play' ? 'test' : mode,
        ui: !document.body.classList.contains('sp-capture-clean'), options: deps.getOptions(),
        size,
      });
      return url.href;
    },
  };
}
