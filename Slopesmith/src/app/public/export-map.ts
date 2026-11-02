import './new-map.css';
import type { PublicCourse } from '../../core/session/public-courses';
import type { ProjectBundle } from '../../core/project/transfer';
import { buildExportFolder, exportFolderName } from '../../core/export/folder';
import { referenceExportFolder } from '../../core/export/reference';
import { assetVersionsIn } from '../../core/reference/asset-version';
import { safeDataName } from '../../core/export/names';
import { mapGame } from '../../core/reference/map-game';
import { createMountainArchive } from '../mountain/archive';
import { browserExportProvider } from '../export/provider';
import { downloadTarget } from '../export/landing';
import { createSnowknifeCommands, snowknifeTarget } from '../export/commands';
import { readLocalProject } from '../state/local-projects';
import { cachedCourseFiles } from './iso-cache';
import { publicBundle } from './local-editor';
import { courseExportSource } from './course-export-source';
import { element, publicJson } from './dom';

/** Library rows export their own stored content, rather than the editor's current document. */
export function showMapExportDialog(course: PublicCourse): void {
  if (document.querySelector('.public-export-map-dialog')) return;
  const dialog = element('dialog', 'public-new-map-dialog public-export-map-dialog');
  dialog.setAttribute('aria-label', 'Export');
  const title = element('h2', '', `Export — ${course.name}`);
  const label = element('label', '', 'Export for');
  const purpose = element('select', '');
  purpose.setAttribute('aria-label', 'Export for');
  if (course.kind === 'project') purpose.add(new Option('Another Slopesmith instance', 'slopesmith'));
  purpose.add(new Option('Snowknife — Custom ISO', 'snowknife-iso'));
  purpose.add(new Option('Snowknife — Mod Manager', 'snowknife-mod-manager'));
  label.append(purpose);
  const hint = element('p', 'public-new-map-hint');
  const commands = createSnowknifeCommands(
    course.kind === 'reference' ? safeDataName(course.id) : exportFolderName(course),
  );
  const error = element('p', 'public-new-map-error');
  error.setAttribute('role', 'alert');
  const actions = element('div', 'public-new-map-actions');
  const cancel = element('button', '', 'Cancel');
  const go = element('button', 'public-new-map-submit');
  cancel.onclick = () => dialog.close();
  function updatePurpose() {
    const target = snowknifeTarget(purpose.value);
    const snowknife = target !== null;
    go.textContent = snowknife ? 'Download .snowknife.zip' : 'Download .slopesmith.zip';
    hint.textContent = snowknife
      ? `Download this map as a .snowknife.zip input for Snowknife to build ${target === 'iso' ? 'a custom PS2 Tricky ISO' : 'a ZIP for SSX Mod Manager'}. The archive includes build commands in Repack.md.`
      : 'Download the editable mountain and its custom assets for another Slopesmith instance.';
    if (snowknife && course.kind === 'reference' && mapGame({ name: course.id }) === 'ssx-tricky-gba')
      hint.textContent +=
        ' The Tricky build keeps its sky and soundtrack. GBA pickups and checkpoints are not converted.';
    commands.setTarget(target);
  }
  purpose.onchange = updatePurpose;
  updatePurpose();
  go.onclick = async () => {
    go.disabled = purpose.disabled = cancel.disabled = true;
    go.textContent = 'Exporting…';
    error.textContent = '';
    dialog.setAttribute('aria-busy', 'true');
    try {
      await exportCourse(course, snowknifeTarget(purpose.value) !== null);
      dialog.close();
    } catch (e) {
      error.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      go.disabled = purpose.disabled = cancel.disabled = false;
      dialog.removeAttribute('aria-busy');
      updatePurpose();
    }
  };
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.addEventListener('cancel', event => {
    if (go.disabled) event.preventDefault();
  });
  actions.append(cancel, go);
  dialog.append(title, label, hint, commands.element, error, actions);
  document.body.append(dialog);
  dialog.showModal();
  purpose.focus();
}

async function exportCourse(course: PublicCourse, snowknife: boolean) {
  if (course.kind === 'reference') {
    const files =
      course.source === 'iso'
        ? await Promise.all(
            (await cachedCourseFiles(course.id)).map(async file => ({
              path: file.path,
              bytes: new Uint8Array(await file.blob.arrayBuffer()),
            })),
          )
        : await serverCourseFiles(course.id);
    const name = safeDataName(course.id);
    await downloadTarget(name).land(referenceExportFolder(name, files));
    return;
  }
  const bundle = course.localProjectId
    ? await readLocalProject(course.localProjectId)
    : course.private
      ? await publicJson<ProjectBundle>(`/api/projects/${encodeURIComponent(course.id)}/download?assets=bytes`)
      : await publicBundle(course);
  if (!bundle) throw new Error('This mountain is no longer saved on this device.');
  if (!snowknife) {
    const download = createMountainArchive(bundle);
    const url = URL.createObjectURL(download.blob);
    const a = element('a', '');
    a.href = url;
    a.download = download.filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }
  if (bundle.missing?.length) throw new Error(`The mountain is missing assets: ${bundle.missing.join(', ')}`);
  const source = await courseExportSource(bundle, course.isoAliases);
  try {
    const name = exportFolderName(bundle.document);
    const target = downloadTarget(name);
    const provider = browserExportProvider({
      folderName: name,
      assetLevels: assetVersionsIn(bundle.document),
      existingFile: async () => false,
      request: source.request,
    });
    await target.land(await buildExportFolder(bundle.document, provider, { lighting: true, aiPaths: true }));
  } finally {
    source.dispose();
  }
}

async function serverCourseFiles(level: string) {
  const base = `/api/map-files?level=${encodeURIComponent(level)}`;
  const { files } = await publicJson<{ files: string[] }>(base);
  const result = [];
  // Bound network and memory pressure for courses with many small model files.
  for (let i = 0; i < files.length; i += 8) {
    result.push(
      ...(await Promise.all(
        files.slice(i, i + 8).map(async path => {
          const response = await fetch(`${base}&path=${encodeURIComponent(path)}`);
          if (!response.ok) throw new Error(`Could not export ${path}.`);
          return { path, bytes: new Uint8Array(await response.arrayBuffer()) };
        }),
      )),
    );
  }
  return result;
}
