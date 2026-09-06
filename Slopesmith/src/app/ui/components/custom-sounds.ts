/**
 * The mountain-local uploaded-WAV channel, shared by every panel that can assign one.
 *
 * Props reach it for hit and ambient sounds (docs/012) and Play sound nodes for their clip (docs/026). Those
 * panels render in different toolkits — the props inspector is lil-gui, the effects inspector is hand-built
 * DOM — so what is shared here is the MODEL, not a widget: one cache of the library, one upload-and-name
 * flow, one filepath convention. Each panel draws them in its own idiom.
 */
import { toast } from './toast';
import { clientFetch } from '../../net/client';

/** Uploaded WAVs, fetched once and refreshed after an upload; null = not requested yet. */
let cached: string[] | null = null;
let inFlight: Promise<string[]> | null = null;
const listeners = new Set<() => void>();

/** The list as it stands, without triggering a fetch — null when it has never been loaded. */
export const customSoundsNow = (): readonly string[] | null => cached;

/** Re-render hook for panels that draw the list. Returns its own unsubscribe. */
export function onCustomSoundsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce(): void {
  for (const listener of [...listeners]) listener();
}

/** Load the library once. Concurrent callers share the request; a failure yields an empty list rather than
 *  leaving every caller retrying, since an absent folder is the ordinary "nothing uploaded yet" state. */
export function loadCustomSounds(force = false): Promise<string[]> {
  if (!force && cached) return Promise.resolve(cached);
  if (!force && inFlight) return inFlight;
  cached ??= [];
  inFlight = clientFetch('/api/custom-sounds').then(r => r.json())
    .then((body: { sounds?: string[] }) => body.sounds ?? [])
    .catch(() => [])
    .then(sounds => {
      cached = sounds;
      inFlight = null;
      announce();
      return sounds;
    });
  return inFlight;
}

/** Ensure a load has been kicked off, and report what is available right now. Panels call this while
 *  building: they draw with what they have and redraw from `onCustomSoundsChanged` when the list lands. */
export function customSounds(): readonly string[] {
  if (cached === null) void loadCustomSounds();
  return cached ?? [];
}

/** Compact display path for an uploaded clip in the open mountain. */
export const customSoundFilepath = (file: string, mountainName = 'Mountain'): string => `${mountainName}/Sounds/${file}`;

/**
 * Open a file picker, upload the chosen WAV, and report the name it landed under.
 *
 * The answer names the stored file rather than echoing the request: a taken name stores beside the original
 * as `<name>_2` (docs/038), so the caller must assign what came back, not what was picked. Resolves null when
 * the picker was dismissed or the upload failed (the failure is toasted here).
 */
export function pickCustomSound(): Promise<string | null> {
  return new Promise(resolve => {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = '.wav,audio/wav,audio/x-wav';
    // A dismissed picker fires no event in any browser, so the promise simply never settles on cancel; the
    // caller's continuation is "assign a sound", which is correctly a no-op when nothing was chosen.
    picker.onchange = async () => {
      const chosen = picker.files?.[0];
      if (!chosen) { resolve(null); return; }
      try {
        const response = await clientFetch(`/api/sound-upload?name=${encodeURIComponent(chosen.name)}`,
          { method: 'POST', body: await chosen.arrayBuffer() });
        const result = await response.json() as { name?: string; error?: string };
        if (!result.name) throw new Error(result.error ?? 'upload failed');
        await loadCustomSounds(true);
        resolve(result.name);
      } catch (e) {
        toast(`Sound upload failed: ${e instanceof Error ? e.message : e}`, 'err');
        resolve(null);
      }
    };
    picker.click();
  });
}
