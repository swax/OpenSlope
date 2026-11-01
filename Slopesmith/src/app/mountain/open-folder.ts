import { localEditorUrl } from '../navigation';
import { openLocalProjects } from '../state/local-projects';
import { linkMountainFolder, projectForMountainFolder, requestMountainFolderAccess } from '../state/folder-autosave';
import { pickMountainFolder, readMountainFolder } from './folder';

/** Add a persistent folder connection to the library without changing the open editor or disk file. */
export async function linkLocalMountainFolder(beforeOpen?: () => Promise<void>) {
  const handle = await pickMountainFolder();
  if (!handle) return null;
  await beforeOpen?.();
  const previousId = await projectForMountainFolder(handle);
  const projects = await openLocalProjects();
  try {
    if (previousId && projects.bundle(previousId)) {
      await projects.refreshFolder(previousId, true);
      return projects.list().find(project => project.id === previousId)!;
    }
    const { bundle, hash } = await readMountainFolder(handle);
    const { project } = await projects.restore(bundle, false);
    await linkMountainFolder(project.id, handle, projects.bundle(project.id)!, hash);
    return project;
  } finally {
    projects.close();
  }
}

/** A library click may request renewed access before navigating to an editor or player. */
export async function refreshLocalMountainFolder(id: string) {
  await requestMountainFolderAccess(id);
  const projects = await openLocalProjects();
  try {
    await projects.refreshFolder(id, true);
    return projects.list().find(project => project.id === id)!;
  } finally {
    projects.close();
  }
}

/** The editor's recovery action also opens the linked mountain after flushing its current project. */
export async function openLocalMountainFolder(beforeOpen?: () => Promise<void>): Promise<void> {
  const project = await linkLocalMountainFolder(beforeOpen);
  if (project) location.assign(localEditorUrl(project.name, project.id));
}
