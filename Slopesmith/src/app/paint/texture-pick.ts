import type { TexRef } from '../../core/paint/textures';

/** A request to choose a texture from the shared library panel: one-shot, or — `keep` — standing. */
export interface TexturePick {
  /** What the panel is being asked, e.g. `Choose a texture — Sign`. */
  title: string;
  /** Highlighted and scrolled to on open. */
  current: TexRef | null;
  /** A tile was chosen; null clears the field. */
  onPick(ref: TexRef | null): void;
  onCancel?(): void;
  /** A standing request: every tile clicked answers it and the panel stays up — its tiles still dragged out — until
   *  it is closed (Esc, Done, or the next request). The trail tile set builder's library. */
  keep?: boolean;
  /** For a standing request, what a click and a drag do, in the panel's hint. */
  hint?: string;
}
