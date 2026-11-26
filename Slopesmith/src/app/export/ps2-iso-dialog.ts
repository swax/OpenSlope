import type { EditDoc } from '../../core/doc/doc-edit';
import { exportFolderName } from '../../core/export/folder';
import { discContainsCourse } from '../../core/reference/disc-courses';
import { savedIsoDiscs } from '../public/iso-discs';
import { toast } from '../ui/components/toast';
import { downloadBlob } from './landing';
import { exportMapFolder } from './run';
import { zipStoreOnly } from './zip';
import type { BuildIsoRequest, BuildIsoReply } from './ps2-iso-worker';

export function createPs2IsoExport(getDoc: () => EditDoc, log: (message: string) => void) {
  const element = document.createElement('div');
  element.className = 'sp-iso-source';
  element.hidden = true;
  const source = document.createElement('p');
  const label = document.createElement('label');
  const labelText = document.createTextNode('SSX Tricky ISO');
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = '.iso';
  label.append(labelText, file);
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  element.append(source, label, status);

  let saved: File | undefined;
  let lookingUp = false;
  let lookedUp = false;
  let active: AbortController | undefined;
  let sourceChanged = () => {};
  const selected = () => file.files?.[0] ?? saved;

  function renderSource() {
    const picked = file.files?.[0];
    source.textContent = picked
      ? `Source ISO: ${picked.name}`
      : saved
        ? `Using ${saved.name} from /isos`
        : lookingUp
          ? 'Checking for a saved ISO…'
          : '';
    source.hidden = !source.textContent;
    labelText.textContent = saved ? 'Use a different ISO' : 'SSX Tricky ISO';
    sourceChanged();
  }
  file.onchange = () => {
    status.textContent = '';
    renderSource();
  };

  async function loadSaved() {
    if (lookedUp || lookingUp) return;
    lookingUp = true;
    renderSource();
    try {
      const discs = await savedIsoDiscs();
      saved = discs.find(disc => disc.game === 'tricky' && discContainsCourse(disc.courses, 'TRICKY_GARI'))?.file;
    } catch {
      // A file picked in the dialog is still usable if browser storage is unavailable.
    } finally {
      lookingUp = false;
      lookedUp = true;
      renderSource();
    }
  }

  async function build() {
    const iso = selected();
    if (!iso || active) return false;
    const controller = (active = new AbortController());
    const { signal } = controller;
    file.disabled = true;
    try {
      const map = structuredClone(getDoc());
      const folderName = exportFolderName(map);
      const filename = `ssx-tricky-${folderName.toLowerCase()}.iso`;
      status.textContent = 'Preparing the map for Snowknife…';
      const result = await exportMapFolder(map, {
        folderName,
        label: filename,
        existingFile: async () => false,
        async land(folder) {
          signal.throwIfAborted();
          const archive = zipStoreOnly(folderName, folder.files);
          const result = await repack({ iso, archive }, signal, text => (status.textContent = text));
          signal.throwIfAborted();
          downloadBlob(result.output, filename);
          return result.log.join('\n');
        },
      });
      const alert = result.log.split('\n').find(line => line.includes('ALERT:'));
      toast(
        alert ? `Built ${filename} with a PS2 compatibility warning. See the export log.` : `Built ${filename}`,
        alert ? 'warn' : 'ok',
        6000,
      );
      log(`${result.destination}\n\n${result.log}`);
      return true;
    } catch (error) {
      if (!signal.aborted) {
        status.textContent = error instanceof Error ? error.message : String(error);
        log(`ISO BUILD FAILED\n${status.textContent}`);
      }
      return false;
    } finally {
      active = undefined;
      file.disabled = false;
    }
  }

  return {
    element,
    loadSaved,
    ready: () => !!selected() && !active,
    onSourceChange: (update: () => void) => {
      sourceChanged = update;
    },
    build,
    abort: () => active?.abort(),
  };
}

function repack(request: BuildIsoRequest, signal: AbortSignal, progress: (message: string) => void) {
  return new Promise<Extract<BuildIsoReply, { type: 'done' }>>((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new Worker(new URL('./ps2-iso-worker.ts', import.meta.url), { type: 'module' });
    const stop = () => {
      signal.removeEventListener('abort', cancel);
      worker.terminate();
    };
    const cancel = () => {
      stop();
      reject(signal.reason);
    };
    signal.addEventListener('abort', cancel, { once: true });
    worker.onmessage = ({ data }: MessageEvent<BuildIsoReply>) => {
      if (data.type === 'progress') {
        progress(data.message);
        return;
      }
      stop();
      if (data.type === 'error') reject(new Error(data.message));
      else resolve(data);
    };
    worker.onerror = event => {
      stop();
      reject(new Error(event.message || 'The Snowknife worker stopped unexpectedly.'));
    };
    worker.postMessage(request);
  });
}
