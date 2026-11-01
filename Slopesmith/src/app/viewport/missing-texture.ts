let canvas: HTMLCanvasElement | undefined;
let url: string | undefined;
/** Deliberate failure art; never used for pending loads or intentionally untextured surfaces. */
export function missingTextureCanvas(): HTMLCanvasElement {
  if (canvas) return canvas;
  canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d')!;
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      context.fillStyle = (x + y) % 2 ? '#ff00ff' : '#190019';
      context.fillRect(x * 8, y * 8, 8, 8);
    }
  return canvas;
}
export const missingTextureUrl = () => (url ??= missingTextureCanvas().toDataURL('image/png'));
