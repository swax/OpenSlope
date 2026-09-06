/** The small, DOM-free transform shared by an interactive square image cropper. */
export interface SquareCrop {
  image: { readonly width: number; readonly height: number };
  zoom: number;
  /** Output-square offsets, where 1 is the square's full width/height. */
  offsetX: number;
  offsetY: number;
}

/** Cover an arbitrary output rectangle. Offsets are normalized to that rectangle's width and height. */
export function coverCropRect(crop: SquareCrop, outputWidth: number, outputHeight: number) {
  const scale = Math.max(outputWidth / crop.image.width, outputHeight / crop.image.height) * crop.zoom;
  const width = crop.image.width * scale, height = crop.image.height * scale;
  return { width, height, x: (outputWidth - width) / 2 + crop.offsetX * outputWidth,
    y: (outputHeight - height) / 2 + crop.offsetY * outputHeight };
}

export function squareCropRect(crop: SquareCrop, size: number) {
  return coverCropRect(crop, size, size);
}

/** Drag may reveal a different part of the source, but never empty pixels outside it. */
export function clampCoverCrop(crop: SquareCrop, outputWidth: number, outputHeight: number): void {
  const rect = coverCropRect(crop, outputWidth, outputHeight);
  const horizontal = (rect.width - outputWidth) / (2 * outputWidth);
  const vertical = (rect.height - outputHeight) / (2 * outputHeight);
  crop.offsetX = Math.max(-horizontal, Math.min(horizontal, crop.offsetX));
  crop.offsetY = Math.max(-vertical, Math.min(vertical, crop.offsetY));
}

export function clampSquareCrop(crop: SquareCrop): void {
  clampCoverCrop(crop, 1, 1);
}

/** Keep the source point under the focus point stationary while changing scale. */
export function zoomCoverCrop(
  crop: SquareCrop, zoom: number, maximumZoom: number, outputWidth: number, outputHeight: number,
  focusX = 0.5, focusY = 0.5,
): void {
  const next = Math.max(1, Math.min(maximumZoom, zoom));
  const ratio = next / crop.zoom;
  crop.offsetX = (focusX - 0.5) - ((focusX - 0.5) - crop.offsetX) * ratio;
  crop.offsetY = (focusY - 0.5) - ((focusY - 0.5) - crop.offsetY) * ratio;
  crop.zoom = next;
  clampCoverCrop(crop, outputWidth, outputHeight);
}

export function zoomSquareCrop(
  crop: SquareCrop, zoom: number, maximumZoom: number, focusX = 0.5, focusY = 0.5,
): void {
  zoomCoverCrop(crop, zoom, maximumZoom, 1, 1, focusX, focusY);
}
