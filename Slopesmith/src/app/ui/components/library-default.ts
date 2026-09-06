/**
 * Which source a library opens on.
 *
 * One rule, stated once, for the Texture, Prop and Sound libraries: **your own content first, then the level
 * you are studying.** Both halves matter. Opening on Custom when it has anything puts the author's own tiles,
 * models and clips in front of them rather than behind a level list they then have to hunt through; falling
 * back to the loaded reference keeps a first-run editor useful instead of landing on whichever level happens
 * to sort first, which is nobody's intent.
 *
 * An empty Custom deliberately loses to the reference — a view whose only content is an "add" button is not
 * where anyone wants to start.
 */
export interface LibrarySourceChoice {
  /** The Custom source's own key, e.g. `@custom` / `@models`. */
  custom: string;
  /** Whether Custom holds anything yet. False sends the choice on to the reference. */
  hasCustom: boolean;
  /** The loaded reference level, when one is loaded. */
  reference?: string | null;
  /** Whether a key is actually offered — a reference that was never extracted is not selectable. */
  has: (key: string) => boolean;
  /** Last resort when neither Custom nor the reference is available. */
  fallback?: string;
}

export function defaultLibrarySource(choice: LibrarySourceChoice): string {
  const { custom, hasCustom, reference, has, fallback } = choice;
  if (hasCustom && has(custom)) return custom;
  const ref = (reference ?? '').trim();
  // A reference that has not loaded yet reports empty, and `(none)`-style placeholders are not levels.
  if (ref && !ref.startsWith('(') && has(ref)) return ref;
  return fallback ?? (has(custom) ? custom : '');
}
