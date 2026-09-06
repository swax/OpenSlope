import { BUILTIN_CHARACTERS, DEFAULT_CHARACTER_MODEL_ID } from '../../core/characters/builtins';

export const PROCEDURAL_RIDER_MODEL_ID = 'procedural';
export const DEFAULT_RIDER_MODEL_ID = DEFAULT_CHARACTER_MODEL_ID;

export interface RiderModelOption {
  id: string;
  file: string | null;
  label: string;
}

const procedural: RiderModelOption = {
  id: PROCEDURAL_RIDER_MODEL_ID,
  file: null,
  label: 'Procedural',
};
const builtins: RiderModelOption[] = BUILTIN_CHARACTERS.map(character => ({ ...character }));
let catalog: RiderModelOption[] = [...builtins, procedural];
let catalogRequest: Promise<readonly RiderModelOption[]> | null = null;
let catalogSettled = false;

export function riderModelOptions(): readonly RiderModelOption[] { return catalog; }
export function riderModelCatalogSettled(): boolean { return catalogSettled; }

/** Fetch the flat server-wide character catalogue once. Every built-in choice survives an API failure. */
export function ensureRiderModelCatalog(): Promise<readonly RiderModelOption[]> {
  catalogRequest ??= fetch('/api/characters', { cache: 'no-store' })
    .then(async response => {
      if (!response.ok) throw new Error(`character catalog returned ${response.status}`);
      const payload = await response.json() as { characters?: unknown };
      const raw = Array.isArray(payload.characters) ? payload.characters : [];
      const found: RiderModelOption[] = [];
      for (const value of raw) {
        if (!value || typeof value !== 'object') continue;
        const row = value as { id?: unknown; file?: unknown; label?: unknown };
        if (typeof row.id !== 'string' || typeof row.file !== 'string' || typeof row.label !== 'string') continue;
        if (!/^[^/\\]+\.glb$/i.test(row.file) || row.id !== row.file) continue;
        found.push({ id: row.id, file: row.file, label: row.label });
      }
      catalog = [...builtins, procedural, ...found];
      return catalog;
    })
    .catch(error => {
      console.warn('Character catalog did not load; keeping the built-in rider choices.', error);
      return catalog;
    })
    .finally(() => { catalogSettled = true; });
  return catalogRequest;
}

/** Re-read the flat catalogue after a server-side import without requiring an editor reload. */
export function refreshRiderModelCatalog(): Promise<readonly RiderModelOption[]> {
  catalogRequest = null;
  catalogSettled = false;
  return ensureRiderModelCatalog();
}
