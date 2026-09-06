import { parentPort } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import type { WorkerTask } from '../worker-pool';

/**
 * The pool's worker entry: perform one CPU-heavy project-document or reference-data task and post it back.
 *
 * The task carries the resolved map and workspace roots rather than letting the worker read the bootstrap
 * config itself, so a worker can never disagree with the main thread about which library it is serving —
 * including when the main thread's memoised config was resolved from an environment override.
 *
 * Each implementation is imported lazily so an idle worker loads none of the editor or reference pipeline.
 */
parentPort?.on('message', async (task: WorkerTask) => {
  try {
    if (task.kind === 'document-read') {
      const [{ canonicalJson }, { migrateMountain }] = await Promise.all([
        import('../../core/doc/canonical'), import('../../core/doc/mountain'),
      ]);
      const document = migrateMountain(JSON.parse(await readFile(task.file, 'utf8')));
      parentPort?.postMessage({ ok: true, value: { document, canonical: canonicalJson(document) } });
      return;
    }

    if (task.kind === 'document') {
      const [{ canonicalJson }, { serializeMountain }] = await Promise.all([
        import('../../core/doc/canonical'), import('../../core/doc/serialize'),
      ]);
      parentPort?.postMessage({
        ok: true,
        value: {
          canonical: canonicalJson(task.document),
          storedJson: `${JSON.stringify(serializeMountain(task.document), null, 2)}\n`,
        },
      });
      return;
    }

    process.env.SLOPESMITH_MAPS_ROOT = task.mapsRoot;
    process.env.SLOPESMITH_WORKSPACE_ROOT = task.workspaceRoot;
    const { forgetWorkspaceConfig } = await import('../workspace-config');
    forgetWorkspaceConfig(); // the assignments above must win over anything already resolved in this thread

    const { buildLevelPropsUncached } = await import('../routes/props');
    const json = new TextEncoder().encode(JSON.stringify(await buildLevelPropsUncached(task.level)));
    // Transfer the serialized payload instead of structured-cloning its many geometry arrays into the main
    // isolate. The receiving Buffer, persistent cache and HTTP cache can all own these same bytes in turn.
    parentPort?.postMessage({ ok: true, value: json }, [json.buffer]);
  } catch (error) {
    // Errors do not survive structured cloning with their stack intact, so send the message text.
    parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
