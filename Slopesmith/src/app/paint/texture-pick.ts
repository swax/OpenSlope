import type { TexRef } from '../../core/paint/textures';

/** A one-shot request to choose a texture from the shared library panel. */
export interface TexturePick {
  /** What the panel is being asked, e.g. `Choose a texture — Sign`. */
  title: string;
  /** Highlighted and scrolled to on open. */
  current: TexRef | null;
  /** A tile was chosen; null clears the field. */
  onPick(ref: TexRef | null): void;
  onCancel?(): void;
}
