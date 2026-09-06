import type { Reconciliation, SyncStatus } from '../net/register-sync';
import type { ProjectSaveState } from './project-sync';
import { SAVE_ICON } from '../ui/components/icons';
import { tooltip } from '../ui/components/tooltip';

/**
 * One save icon in the top bar, plus a panel only when reconnecting needs words or a decision (docs/039).
 *
 * Acknowledgement is a real thing an author needs — a change is *local*, *in flight* or *landed* — and it is
 * deliberately NOT drawn on the mesh. Decorating geometry with its own delivery state turns an editor into a
 * dashboard: it puts a second colour language on top of selection and paint, and it says something about
 * every element when the only interesting fact is whether the document is safe. A steady disk means saved; it
 * pulses while whole-document autosave or shared-register delivery is active, turns amber while reconnecting,
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
}) {
  const indicator = document.createElement('span');
  indicator.id = 'save-status';
  indicator.className = 'sp-save-status';
  indicator.innerHTML = SAVE_ICON;
  indicator.setAttribute('role', 'status');
  indicator.setAttribute('aria-live', 'polite');

  const notice = document.createElement('div');
  notice.id = 'sync-status';
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  notice.style.cssText = 'position:fixed;top:50px;right:12px;z-index:60;display:none;max-width:320px;'
    + 'padding:5px 9px;border-radius:6px;border:1px solid #2c3b48;background:rgba(16,22,28,0.92);'
    + 'color:#8fa6b8;font:11px/1.45 system-ui,sans-serif;pointer-events:none;';
  const line = document.createElement('div');
  const actions = document.createElement('div');
  actions.style.cssText = 'margin-top:5px;display:none;gap:6px;pointer-events:auto;';
  const button = (text: string, run: () => void): HTMLButtonElement => {
    const made = document.createElement('button');
    made.type = 'button';
    made.textContent = text;
    made.style.cssText = 'padding:2px 8px;border-radius:4px;border:1px solid #35485a;background:#1b2530;'
      + 'color:#cfe0ee;font:11px system-ui,sans-serif;cursor:pointer;';
    made.addEventListener('click', run);
    actions.appendChild(made);
    return made;
  };
  button('Put mine back', () => { deps.replay(); clearReconciliation(); });
  button('Leave theirs', () => { deps.discard(); clearReconciliation(); });
  notice.append(line, actions);
  (deps.host ?? document.body).appendChild(notice);

  let pending: Reconciliation | null = null;
  let shared = false;
  let sync: SyncStatus | null = null;
  let projectState: ProjectSaveState = 'loading';
  let projectDetail = 'Opening mountain';
  let indicatorMessage = projectDetail;
  const detachTooltip = tooltip(indicator, () => indicatorMessage);

  function reconnecting(status: SyncStatus): string {
    return status.held
      ? `Reconnecting — ${status.held} change${status.held === 1 ? '' : 's'} held safely here`
      : 'Reconnecting';
  }

  /** Collapse the two transports into the one fact the author needs at a glance. */
  function repaintIndicator(): void {
    let state: 'saved' | 'saving' | 'reconnecting' | 'error' | 'following' = 'saved';
    let message = projectDetail || 'All changes saved';
    if (projectState === 'error' || projectState === 'conflict' || projectState === 'recovery-only') {
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
      message = sync.inFlight
        ? `Saving ${sync.inFlight} change${sync.inFlight === 1 ? '' : 's'}…`
        : 'Saving changes…';
    } else if (projectState === 'following') {
      state = 'following';
      message = projectDetail || 'Following this mountain read-only';
    } else if (projectState === 'shared' || shared) {
      message = 'All changes saved to the shared mountain';
    } else if (projectState === 'saved') {
      message = projectDetail || 'All changes saved';
    }
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
    /** Whole-document autosave and project operations (create/import/restore) share the same disk icon. */
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
      line.textContent = `Away ${minutes} minute${minutes === 1 ? '' : 's'} — `
        + `${summary.changes.length} change${summary.changes.length === 1 ? '' : 's'} held`
        + (summary.contested.length ? `, ${summary.contested.length} changed here since` : '');
      notice.style.display = 'block';
      notice.style.color = '#d38f6a';
      actions.style.display = 'flex';
      notice.style.pointerEvents = 'auto';
      repaintIndicator();
    },
    pending: (): Reconciliation | null => pending,
    dispose(): void { detachTooltip(); notice.remove(); indicator.remove(); },
  };

  function setSharedState(next: boolean): void {
    shared = next;
    if (!shared) clearReconciliation();
    else { repaintNotice(); repaintIndicator(); }
  }
}

export type SyncStatusChip = ReturnType<typeof createSyncStatus>;
