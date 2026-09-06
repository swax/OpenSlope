import type { Mode } from './viewport/types';

/** The six top-level editor views in their visible top-bar / numeric-shortcut order. */
export const MODE_SHORTCUTS = [
  { key: '1', mode: 'info', label: 'Scene' }, // user-facing name is Scene; the stored mode value stays 'info'
  { key: '2', mode: 'edit', label: 'Edit' },
  { key: '3', mode: 'sculpt', label: 'Sculpt' },
  { key: '4', mode: 'paint', label: 'Paint' },
  { key: '5', mode: 'props', label: 'Props' },
  { key: '6', mode: 'effects', label: 'Effects' },
  { key: '7', mode: 'play', label: 'Test' }, // user-facing name is Test; the stored mode value stays 'play'
] as const satisfies readonly { key: string; mode: Mode; label: string }[];

export function modeForShortcut(key: string): Mode | null {
  return MODE_SHORTCUTS.find(item => item.key === key)?.mode ?? null;
}

export function shortcutForMode(mode: Mode) {
  return MODE_SHORTCUTS.find(item => item.mode === mode)!;
}
