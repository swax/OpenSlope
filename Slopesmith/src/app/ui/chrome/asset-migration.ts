import type { EditDoc } from '../../../core/doc/doc-edit';
import { applyAssetMigration, previewAssetMigration } from '../../../core/reference/asset-migration';
import { assetMigrationSources } from '../../net/asset-migration';
import { administersServer } from '../../net/account';
import { modal } from '../components/modal';
import '../../styles/modals.css';

export async function showAssetMigration(deps: {
  getDoc(): EditDoc;
  setDoc(doc: EditDoc): void;
  isWritable(): boolean;
  checkpoint(): Promise<unknown>;
  reload(): void | Promise<void>;
}): Promise<void> {
  if (!(await administersServer())) return;
  const { host, close } = modal({ sticky: true });
  host.classList.add('sp-export-modal');
  host.style.width = 'min(760px, 92vw)';
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-label', 'Review asset references');
  const heading = document.createElement('h2');
  heading.textContent = 'Review asset references';
  const note = document.createElement('p');
  note.textContent =
    'Check current texture bytes, prop definitions and their images before pinning references. A current match preserves the resolved asset; it does not establish the historical original of an unversioned reference. Other candidates require an explicit selection.';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = 'Checking available assets…';
  const list = document.createElement('div');
  list.style.cssText = 'max-height:50vh;overflow:auto;display:grid;gap:8px';
  const actions = document.createElement('div');
  actions.className = 'sp-modal-actions';
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.onclick = close;
  const apply = document.createElement('button');
  apply.textContent = 'Apply selected references';
  apply.disabled = true;
  actions.append(cancel, apply);
  host.append(heading, note, status, list, actions);
  cancel.focus();
  try {
    const preview = await previewAssetMigration(deps.getDoc(), assetMigrationSources());
    if (!host.isConnected) return;
    const selected = new Set<string>();
    const update = () => {
      apply.disabled = !deps.isWritable() || !selected.size;
    };
    const labels = {
      verified: 'Exact original available',
      matching: 'Matches current asset',
      different: 'Different from current asset — review before replacing',
      current: 'Current asset could not be verified',
      replacement: 'Replacement — original version unavailable',
      missing: 'Asset unavailable',
    };
    for (const row of preview.rows) {
      const label = document.createElement('label');
      label.style.cssText =
        'display:block;padding:8px;border:1px solid #405064;border-radius:4px;overflow-wrap:anywhere';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.disabled = !row.to || !deps.isWritable();
      check.checked = !!row.to && ['verified', 'matching'].includes(row.status);
      if (check.checked) selected.add(row.id);
      check.onchange = () => {
        if (check.checked) selected.add(row.id);
        else selected.delete(row.id);
        update();
      };
      const summary = document.createElement('strong');
      summary.textContent = `${labels[row.status]} · ${row.paths.length} reference${row.paths.length === 1 ? '' : 's'}`;
      const before = document.createElement('div');
      before.textContent = row.kind === 'texture' ? row.from : `${row.from} · ${row.kind} ${row.key}`;
      const after = document.createElement('div');
      after.textContent = row.to ? `→ ${row.to} (${row.source})` : 'Load the source assets and review again.';
      label.append(check, summary, before, after);
      list.append(label);
    }
    status.textContent = preview.rows.length
      ? `${preview.rows.length} assets reviewed. Unselected references remain unchanged.`
      : 'No legacy asset references need migration.';
    update();
    apply.onclick = async () => {
      apply.disabled = cancel.disabled = true;
      try {
        // Recheck both before and after the checkpoint so concurrent edits cannot be lost.
        applyAssetMigration(deps.getDoc(), preview, [...selected]);
        await deps.checkpoint();
        if (!deps.isWritable()) throw new Error('This mountain is read-only.');
        deps.setDoc(applyAssetMigration(deps.getDoc(), preview, [...selected]));
        await deps.reload();
        close();
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
        cancel.disabled = false;
        update();
      }
    };
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  }
}
