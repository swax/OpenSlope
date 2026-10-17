import { localEditorUrl } from '../navigation';
import { openLocalProjects } from '../state/local-projects';
import { connectMountainFolder, projectForMountainFolder } from '../state/folder-autosave';
import { pickMountainFolder, readMountainFolder } from './folder';

/** A user-picked disk copy can rebuild the browser workspace after all site data has been cleared. */
export async function openLocalMountainFolder(beforeOpen?: () => Promise<void>): Promise<void> {
  const handle = await pickMountainFolder();
  if (!handle) return;
  await beforeOpen?.();
  const { bundle, hash } = await readMountainFolder(handle);
  const previousId = await projectForMountainFolder(handle, hash);
  const projects = await openLocalProjects();
  try {
    if (!previousId || !projects.open(previousId)) await projects.restore(bundle);
    const project = projects.activeProject()!;
    await connectMountainFolder(project.id, handle, projects.current()!, hash);
    location.assign(localEditorUrl(project.name, project.id));
  } finally {
    projects.close();
  }
}
