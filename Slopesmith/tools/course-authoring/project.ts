/** Shared persistence/export seam for standalone authored-course publishers. */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { serializeMountain } from '../../src/core/doc/serialize';
import type { QuadMeshDoc } from '../../src/core/doc/types';
import { createProject, listProjects, openProject, saveProject, type ProjectSnapshot } from '../../src/server/projects';
import { exportLevel } from '../../src/server/routes/export';

type ExportOptions = NonNullable<Parameters<typeof exportLevel>[1]>;

export interface PublishCourseDocumentOptions {
  document: QuadMeshDoc;
  /** Tracked authored snapshot written before the workspace project is updated. */
  sourceFile: string;
  /** Existing workspace lookup key; defaults to `document.name`. */
  projectName?: string;
  /** Set false for a workspace-only publish. */
  export?: boolean;
  exportOptions?: ExportOptions;
  /** Course-specific round-trip assertions over the reopened workspace document. */
  verify?: (reopened: QuadMeshDoc, source: QuadMeshDoc) => void;
}

export interface PublishedCourseDocument {
  action: 'created' | 'updated';
  snapshot: ProjectSnapshot;
  reopened: QuadMeshDoc;
  sourceFile: string;
  map?: string;
}

export async function publishCourseDocument(
  options: PublishCourseDocumentOptions,
): Promise<PublishedCourseDocument> {
  await mkdir(dirname(options.sourceFile), { recursive: true });
  await writeFile(options.sourceFile, `${JSON.stringify(serializeMountain(options.document), null, 2)}\n`);

  const projectName = (options.projectName ?? options.document.name).toUpperCase();
  const existing = (await listProjects()).find(project => project.name.toUpperCase() === projectName);
  const snapshot = existing
    ? await saveProject(existing.id, existing.revision, options.document)
    : await createProject(options.document);
  const reopened = (await openProject(snapshot.project.id, true)).document as QuadMeshDoc;
  options.verify?.(reopened, options.document);

  const exported = options.export === false
    ? undefined
    : await exportLevel(reopened, options.exportOptions ?? { lighting: true, aiPaths: true });
  return {
    action: existing ? 'updated' : 'created',
    snapshot,
    reopened,
    sourceFile: options.sourceFile,
    ...(exported ? { map: exported.dir } : {}),
  };
}
