import * as THREE from 'three';
import { captureProgress } from '../state/capture-progress';

/** Only scene loaders use this manager; library thumbnails do not hold a capture open. */
export const renderLoadingManager = new THREE.LoadingManager();
const held = new Map<string, Array<{ finish: (error?: unknown) => void; error?: string }>>();
const start = renderLoadingManager.itemStart.bind(renderLoadingManager);
const end = renderLoadingManager.itemEnd.bind(renderLoadingManager);
const fail = renderLoadingManager.itemError.bind(renderLoadingManager);
renderLoadingManager.itemStart = url => {
  const queue = held.get(url) ?? [];
  queue.push({ finish: captureProgress.begin(url) }); held.set(url, queue); start(url);
};
renderLoadingManager.itemError = url => {
  const item = held.get(url)?.[0]; if (item) item.error = 'Could not load scene asset.';
  fail(url);
};
renderLoadingManager.itemEnd = url => {
  const queue = held.get(url), item = queue?.shift();
  item?.finish(item.error); if (!queue?.length) held.delete(url); end(url);
};
