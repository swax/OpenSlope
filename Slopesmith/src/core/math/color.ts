import { clamp01 } from './scalar';

/** Parse a six-digit RGB hex colour into normalized channels. */
export function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/** Encode normalized RGB channels as a six-digit hex colour. */
export function rgbToHex(rgb: readonly number[]): string {
  return `#${rgb.map(channel => Math.round(clamp01(channel) * 255).toString(16).padStart(2, '0')).join('')}`;
}
