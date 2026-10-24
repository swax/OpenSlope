import type { QuadMeshDoc } from '../../core/doc/types';
import { markSurfaceLayoutsPending } from '../../core/mesh/surface-object';
import {
  mergeSurfacePreview,
  type MeshPreviewChange,
  type SurfacePreviewInputs,
  type SurfacePreviewRequest,
  type SurfacePreviewResponse,
} from '../../core/mesh/surface-preview';
import type { PreparedPatches } from '../../core/mesh/tessellation';

type PreviewWorker = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror'>;
export const SURFACE_PREVIEW_INTERVAL = 80;

/** The pointer only authors controls. One worker samples the latest source at a bounded rate; completed
 * samples never queue up, and source writes newer than a sample survive its installation. */
export function createSurfacePreviewClient(deps: {
  getDoc(): QuadMeshDoc;
  enabled?(): boolean;
  beginPending(): void;
  streamControls(doc: QuadMeshDoc, change: MeshPreviewChange): void;
  accept(doc: QuadMeshDoc, evaluated: QuadMeshDoc): { doc: QuadMeshDoc; rejected: string | null };
  install(doc: QuadMeshDoc, patches: PreparedPatches): boolean;
  drawn(doc: QuadMeshDoc): void;
  fallback(): void;
  createWorker?: () => PreviewWorker;
}) {
  let worker: PreviewWorker | undefined,
    active = false,
    initialized = false,
    epoch = 0;
  let timer: ReturnType<typeof setTimeout> | undefined,
    lastSent = -Infinity;
  let pending: MeshPreviewChange | undefined;
  let flight: { doc: QuadMeshDoc; inputs: SurfacePreviewInputs; quads: number; freeEdges: number } | undefined;

  function cancel() {
    active = false;
    epoch++;
    pending = undefined;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (flight) {
      worker?.terminate();
      worker = undefined;
    }
    flight = undefined;
  }
  function fallback() {
    cancel();
    deps.fallback();
  }
  function schedule() {
    if (!active || flight || !pending || timer !== undefined) return;
    timer = setTimeout(dispatch, Math.max(0, SURFACE_PREVIEW_INTERVAL - (performance.now() - lastSent)));
  }
  function dispatch() {
    timer = undefined;
    if (!active || flight || !pending) return;
    const doc = deps.getDoc();
    const inputs = structuredClone({ vertices: doc.vertices, edgeHandles: doc.edgeHandles, quadTwist: doc.quadTwist });
    const request: SurfacePreviewRequest = {
      epoch,
      inputs,
      change: pending,
      ...(!initialized ? { initial: doc } : {}),
    };
    pending = undefined;
    flight = { doc, inputs, quads: doc.quads.length, freeEdges: doc.freeEdges?.length ?? 0 };
    lastSent = performance.now();
    try {
      if (!worker) {
        worker =
          deps.createWorker?.() ??
          new Worker(new URL('./surface-preview-worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = event => {
          try {
            received(event.data as SurfacePreviewResponse);
          } catch {
            fallback();
          }
        };
        const created = worker;
        worker.onerror = () => {
          if (worker === created && active) fallback();
        };
      }
      worker.postMessage(request);
      initialized = true;
    } catch {
      fallback();
    }
  }
  function received(result: SurfacePreviewResponse) {
    if (!active || result.epoch !== epoch || !flight) return;
    if (deps.enabled?.() === false) {
      cancel();
      return;
    }
    const job = flight,
      live = deps.getDoc();
    // Undo, document replacement or another authoring operation supersedes this gesture.
    if (
      live.quads !== job.doc.quads ||
      live.vertexIds !== job.doc.vertexIds ||
      live.quadIds !== job.doc.quadIds ||
      live.freeEdges !== job.doc.freeEdges ||
      live.surfaces !== job.doc.surfaces ||
      live.vertices.length !== job.inputs.vertices.length ||
      live.quads.length !== job.quads ||
      (live.freeEdges?.length ?? 0) !== job.freeEdges
    ) {
      cancel();
      return;
    }
    if (result.kind !== 'ready') {
      fallback();
      return;
    }
    const displayed = { ...live, ...result.geometry },
      accepted = deps.accept(live, displayed);
    if (accepted.rejected) {
      fallback();
      return;
    }
    const next = mergeSurfacePreview(live, job.inputs, result.geometry, result.changed);
    markSurfaceLayoutsPending(next, result.changed);
    if (!deps.install(next, result.patches)) {
      fallback();
      return;
    }
    deps.drawn(displayed);
    flight = undefined;
    schedule();
  }
  return {
    begin() {
      cancel();
      active = true;
      initialized = false;
      lastSent = -Infinity;
    },
    cancel,
    pending: () => !!(pending || flight || timer !== undefined),
    preview(change: MeshPreviewChange): boolean {
      if (!active) return false;
      if (deps.enabled?.() === false) {
        cancel();
        return false;
      }
      deps.beginPending();
      deps.streamControls(deps.getDoc(), change);
      pending = {
        vertices: [...new Set([...(pending?.vertices ?? []), ...(change.vertices ?? [])])],
        edges: [...new Map([...(pending?.edges ?? []), ...(change.edges ?? [])].map(e => [e.join(','), e])).values()],
        quads: [...new Set([...(pending?.quads ?? []), ...(change.quads ?? [])])],
      };
      schedule();
      return true;
    },
  };
}
