import { showNewMapDialog } from '../src/app/public/new-map';
import { listLocalProjects, readLocalProject } from '../src/app/state/local-projects';
(window as any).newMap = { show: showNewMapDialog, list: listLocalProjects, read: readLocalProject };
