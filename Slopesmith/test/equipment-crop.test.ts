import { clampCoverCrop, coverCropRect, clampSquareCrop, squareCropRect, zoomCoverCrop, zoomSquareCrop,
  type SquareCrop } from '../src/app/ui/components/square-crop';
import { must } from './check';

const near = (actual: number, expected: number, label: string) => {
  if (Math.abs(actual - expected) > 1e-9) throw new Error(`${label}: expected ${expected}, got ${actual}`);
};
const crop = (width: number, height: number): SquareCrop => ({
  image: { width, height }, zoom: 1, offsetX: 0, offsetY: 0,
});

const wide = crop(1600, 800);
let rect = squareCropRect(wide, 1024);
near(rect.width, 2048, 'wide cover width');
near(rect.height, 1024, 'wide cover height');
near(rect.x, -512, 'wide cover x');
near(rect.y, 0, 'wide cover y');
must(true, 'a non-square image starts centre-cropped with the whole square covered');

wide.offsetX = 50; wide.offsetY = -50;
clampSquareCrop(wide);
near(wide.offsetX, 0.5, 'wide positive horizontal limit');
near(wide.offsetY, 0, 'wide vertical limit');
rect = squareCropRect(wide, 1024);
must(rect.x <= 0 && rect.x + rect.width >= 1024 && rect.y <= 0 && rect.y + rect.height >= 1024,
  'dragging clamps at the source boundary without exposing empty pixels');

const tall = crop(800, 1600);
tall.offsetX = -20; tall.offsetY = -20;
clampSquareCrop(tall);
near(tall.offsetX, 0, 'tall horizontal limit');
near(tall.offsetY, -0.5, 'tall negative vertical limit');
must(true, 'portrait sources pan vertically and remain locked horizontally at fit');

const focused = crop(1000, 1000);
const focusX = 0.8, focusY = 0.25;
const before = squareCropRect(focused, 1);
const sourceX = (focusX - before.x) / before.width;
const sourceY = (focusY - before.y) / before.height;
zoomSquareCrop(focused, 2.5, 6, focusX, focusY);
const after = squareCropRect(focused, 1);
near((focusX - after.x) / after.width, sourceX, 'focused source x');
near((focusY - after.y) / after.height, sourceY, 'focused source y');
must(true, 'wheel zoom keeps the artwork beneath the pointer stationary');

zoomSquareCrop(focused, 99, 6);
near(focused.zoom, 6, 'maximum zoom');
zoomSquareCrop(focused, -4, 6);
near(focused.zoom, 1, 'minimum zoom');
must(true, 'zoom is bounded from the fitted scale through the configured maximum');

const strip = crop(1600, 900);
rect = coverCropRect(strip, 0.25, 1);
near(rect.width, 1600 / 900, 'strip cover width');
near(rect.height, 1, 'strip cover height');
strip.offsetX = 99; strip.offsetY = 99;
clampCoverCrop(strip, 0.25, 1);
rect = coverCropRect(strip, 0.25, 1);
must(rect.x <= 0 && rect.x + rect.width >= 0.25 && rect.y <= 0 && rect.y + rect.height >= 1,
  'a landscape source independently covers a tall ski strip at every allowed pan position');
zoomCoverCrop(strip, 3, 6, 0.25, 1, 0.2, 0.7);
near(strip.zoom, 3, 'strip zoom');
must(true, 'the same crop transform supports board halves and ski quarters without treating them as squares');

console.log('EQUIPMENT CROP PASS');
