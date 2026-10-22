import type { Reconciliation, SyncStatus } from '../net/register-sync';
import type { ProjectSaveState } from './project-sync';
import { svg } from '../ui/components/icons';
import { tooltip } from '../ui/components/tooltip';
import { closeMenu, panelMenu } from '../ui/components/controls';
import { isLocalWorkspace } from '../net/workspace';
import { canSaveMountainFolder, MOUNTAIN_FOLDER_FILE } from '../mountain/folder';
import type { FolderSaveStatus } from './folder-autosave';

/**
 * One save button in the top bar. Its glyph names the destination; clicking shows location and backup actions.
 *
 * Acknowledgement is a real thing an author needs — a change is *local*, *in flight* or *landed* — and it is
 * deliberately NOT drawn on the mesh. Decorating geometry with its own delivery state turns an editor into a
 * dashboard: it puts a second colour language on top of selection and paint, and it says something about
 * every element when the only interesting fact is whether the document is safe. A steady check means saved; it
 * pulses briefly when whole-document autosave or shared-register delivery starts, turns amber while reconnecting,
 * and turns red when a save has failed. Per-element indication earns its place in exactly one case, and it is
 * not this one — it is somebody else overriding a register you touched, which the viewport flashes in their
 * colour.
 *
 * The reconciliation summary shares the chip, because it is the same question asked after a long absence:
 * this is what you changed while you were away, this much of it the room has changed underneath you, put it
 * back or leave it.
 */
export function createSyncStatus(deps: {
  /** Put the held changes back as a fresh assignment. */
  replay: () => void;
  /** Leave the room's values where they are. */
  discard: () => void;
  host?: HTMLElement;
  folder?: () => FolderSaveStatus;
  updatedAt?: () => string | undefined;
  exportMountain?: () => void;
  saveToFolder?: () => void;
  openFolder?: () => void;
  resumeFolder?: () => void;
  stopFolder?: () => void;
}) {
  const indicator = document.createElement('button');
  indicator.type = 'button';
  indicator.id = 'save-status';
  indicator.className = 'sp-save-status';
  indicator.setAttribute('aria-live', 'polite');
  indicator.setAttribute('aria-haspopup', 'true');
  const details = document.createElement('div');
  details.className = 'sp-save-details';
  details.setAttribute('role', 'region');
  details.setAttribute('aria-label', 'Save location');
  const heading = document.createElement('h3');
  const locationLine = document.createElement('p');
  const savedLine = document.createElement('p');
  const statusLine = document.createElement('p');
  statusLine.setAttribute('aria-live', 'polite');
  const detailActions = document.createElement('div');
  details.append(heading, locationLine, savedLine, statusLine, detailActions);
  const detailAction = (label: string, run?: () => void) => {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'sp-btn';
    action.textContent = label;
    action.hidden = !run;
    action.addEventListener('click', () => {
      closeMenu();
      run?.();
    });
    detailActions.append(action);
    return action;
  };
  const exportAction = detailAction('Export mountain…', deps.exportMountain);
  const folderAction = detailAction('Save to folder…', deps.saveToFolder);
  const resumeAction = detailAction('Resume folder autosave', deps.resumeFolder);
  const openAction = detailAction('Open mountain folder…', deps.openFolder);
  const stopAction = detailAction('Stop folder autosave', deps.stopFolder);
  panelMenu(indicator, details);

  const notice = document.createElement('div');
  notice.id = 'sync-status';
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  notice.style.cssText =
    'position:fixed;top:50px;right:12px;z-index:60;display:none;max-width:320px;' +
    'padding:5px 9px;border-radius:6px;border:1px solid #2c3b48;background:rgba(16,22,28,0.92);' +
    'color:#8fa6b8;font:11px/1.45 system-ui,sans-serif;pointer-events:none;';
  const line = document.createElement('div');
  const actions = document.createElement('div');
  actions.style.cssText = 'margin-top:5px;display:none;gap:6px;pointer-events:auto;';
  const button = (text: string, run: () => void): HTMLButtonElement => {
    const made = document.createElement('button');
    made.type = 'button';
    made.textContent = text;
    made.style.cssText =
      'padding:2px 8px;border-radius:4px;border:1px solid #35485a;background:#1b2530;' +
      'color:#cfe0ee;font:11px system-ui,sans-serif;cursor:pointer;';
    made.addEventListener('click', run);
    actions.appendChild(made);
    return made;
  };
  button('Put mine back', () => {
    deps.replay();
    clearReconciliation();
  });
  button('Leave theirs', () => {
    deps.discard();
    clearReconciliation();
  });
  notice.append(line, actions);
  (deps.host ?? document.body).appendChild(notice);

  let pending: Reconciliation | null = null;
  let shared = false;
  let sync: SyncStatus | null = null;
  // Inspect links can open only a reference, without ever starting a project load or save.
  let projectState: ProjectSaveState | 'idle' = 'idle';
  let projectDetail = '';
  let indicatorMessage = projectDetail;
  let indicatorIcon = '';
  const detachTooltip = tooltip(indicator, () => indicatorMessage);

  function reconnecting(status: SyncStatus): string {
    return status.held
      ? `Reconnecting — ${status.held} change${status.held === 1 ? '' : 's'} held safely here`
      : 'Reconnecting';
  }

  /** Collapse the two transports into the one fact the author needs at a glance. */
  function repaintIndicator(): void {
    let state: 'idle' | 'saved' | 'saving' | 'reconnecting' | 'error' | 'following' = 'saved';
    let message = projectDetail || 'All changes saved';
    const idle = projectState === 'idle';
    if (idle) {
      state = 'idle';
      message = 'Viewing reference mountain';
    } else if (projectState === 'error' || projectState === 'conflict' || projectState === 'recovery-only') {
      state = 'error';
      message = projectDetail || 'Save failed';
    } else if (projectState === 'loading' || projectState === 'saving') {
      state = 'saving';
      message = projectDetail || 'Saving…';
    } else if (pending) {
      state = 'reconnecting';
      message = 'Some changes need a reconnect decision';
    } else if (shared && sync && !sync.connected) {
      state = 'reconnecting';
      message = reconnecting(sync);
    } else if (shared && sync && !sync.landed) {
      state = 'saving';
      message = sync.inFlight ? `Saving ${sync.inFlight} change${sync.inFlight === 1 ? '' : 's'}…` : 'Saving changes…';
    } else if (projectState === 'following') {
      state = 'following';
      message = projectDetail || 'Following this mountain read-only';
    } else if (projectState === 'shared' || shared) {
      message = 'All changes saved to the shared mountain';
    } else if (projectState === 'saved') {
      message = projectDetail || 'All changes saved';
    }
    const local = isLocalWorkspace();
    const folder = deps.folder?.() ?? { state: 'none' };
    const connected = local && folder.state !== 'none';
    const destination = idle ? 'none' : local ? (connected ? 'folder' : 'browser') : 'server';
    if (state === 'saved') {
      if (connected && folder.state === 'saving') {
        state = 'saving';
        message = 'Saved in this browser. Saving to folder…';
      } else if (connected && folder.state === 'permission') {
        state = 'reconnecting';
        message = 'Saved in this browser. Folder autosave needs permission.';
      } else if (connected && folder.state === 'error') {
        state = 'error';
        message = 'Saved in this browser. Folder autosave failed.';
      } else
        message = local
          ? connected
            ? 'Saved to folder and this browser'
            : 'Saved in this browser'
          : 'Saved to server';
    } else if (!idle)
      message = `${destination === 'server' ? 'Server' : destination === 'folder' ? 'Folder' : 'Browser'} · ${message}`;
    indicator.dataset.destination = destination;
    const shape =
      destination === 'none'
        ? '<path d="M2 12Q12-2 22 12Q12 26 2 12Z"/><circle cx="12" cy="12" r="3"/>'
        : destination === 'browser'
          ? '<rect x="3" y="3" width="18" height="17" rx="2"/><path d="M3 8h18M6 5.5h.01M9 5.5h.01"/>'
          : destination === 'folder'
            ? '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>'
            : '<path d="M6 18a4 4 0 0 1-1-7.9A7 7 0 0 1 18.5 8a5 5 0 0 1-.5 10H6Z"/>';
    const icon = `${destination}:${state}`;
    // Transport status refreshes must not recreate the SVG and restart its finite pulse.
    if (icon !== indicatorIcon) {
      indicatorIcon = icon;
      indicator.innerHTML = svg(
        shape +
          (state === 'saved'
            ? '<circle cx="18" cy="18" r="5" fill="#10161c" stroke="none"/><path d="m15 18 2 2 4-4"/>'
            : ''),
      );
    }
    heading.textContent = idle
      ? 'Viewing reference mountain'
      : destination === 'server'
        ? 'Saving to server'
        : connected
          ? 'Saving to folder'
          : 'Saving in this browser';
    locationLine.textContent = idle
      ? 'Open or create a mountain to save edits.'
      : local
        ? connected
          ? `${folder.folder}/${MOUNTAIN_FOLDER_FILE} — editable mountain autosave. This copy survives clearing browser data.`
          : 'This browser only. Clearing site data removes these maps. Save to folder or export a mountain backup to keep a copy.'
        : `Your mountain is saved on ${location.host}.`;
    const savedAt = connected ? folder.savedAt : deps.updatedAt?.();
    savedLine.hidden = idle;
    savedLine.textContent = savedAt ? `Last saved: ${new Date(savedAt).toLocaleString()}` : 'No completed save yet';
    statusLine.textContent = idle
      ? 'Reference maps are viewed from their source.'
      : connected && folder.detail
        ? folder.detail
        : message;
    exportAction.hidden = idle || !deps.exportMountain;
    folderAction.hidden = idle || !local || !deps.saveToFolder || !canSaveMountainFolder();
    folderAction.textContent = connected ? 'Change save folder…' : 'Save to folder…';
    openAction.hidden = !deps.openFolder || !canSaveMountainFolder();
    resumeAction.hidden =
      !connected || !deps.resumeFolder || (folder.state !== 'permission' && folder.state !== 'error');
    stopAction.hidden = !connected || !deps.stopFolder;
    indicator.dataset.state = state;
    indicatorMessage = message;
    indicator.setAttribute('aria-label', message);
  }

  /** Ordinary saved/in-flight states live in the icon. The floating panel is reserved for interrupted work. */
  function repaintNotice(): void {
    if (pending) return;
    const interrupted = shared && sync && !sync.connected;
    notice.style.display = interrupted ? 'block' : 'none';
    if (interrupted) {
      line.textContent = reconnecting(sync!);
      notice.style.color = '#d6a56f';
    }
  }

  function clearReconciliation(): void {
    pending = null;
    actions.style.display = 'none';
    notice.style.pointerEvents = 'none';
    repaintNotice();
    repaintIndicator();
  }

  repaintIndicator();

  return {
    indicator,
    refresh: repaintIndicator,
    /** Whole-document autosave and project operations (create/import/restore) share the same save button. */
    project(state: ProjectSaveState, detail = ''): void {
      projectState = state;
      projectDetail = detail;
      repaintIndicator();
    },
    /** Collaboration contributes delivery state only while this tab may write the shared mountain. */
    setShared(next: boolean): void {
      setSharedState(next);
    },
    show(status: SyncStatus): void {
      sync = status;
      repaintNotice();
      repaintIndicator();
    },
    /**
     * A disconnection long enough that replaying blind would be wrong. The chip states what is at stake in
     * counts rather than listing registers — "eleven of the forty-seven have moved since" is the fact a person
     * decides on — and the two buttons are the whole decision.
     */
    reconcile(summary: Reconciliation): void {
      pending = summary;
      const minutes = Math.max(1, Math.round(summary.awayMs / 60_000));
      line.textContent =
        `Away ${minutes} minute${minutes === 1 ? '' : 's'} — ` +
        `${summary.changes.length} change${summary.changes.length === 1 ? '' : 's'} held` +
        (summary.contested.length ? `, ${summary.contested.length} changed here since` : '');
      notice.style.display = 'block';
      notice.style.color = '#d38f6a';
      actions.style.display = 'flex';
      notice.style.pointerEvents = 'auto';
      repaintIndicator();
    },
    pending: (): Reconciliation | null => pending,
    dispose(): void {
      detachTooltip();
      notice.remove();
      indicator.remove();
    },
  };

  function setSharedState(next: boolean): void {
    shared = next;
    if (!shared) clearReconciliation();
    else {
      repaintNotice();
      repaintIndicator();
    }
  }
}

export type SyncStatusChip = ReturnType<typeof createSyncStatus>;
