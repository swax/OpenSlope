import * as THREE from 'three';
import { parseAssetVersion } from '../../core/reference/asset-version';
import { workspaceFetch } from './workspace';
import { reportTextureLoad } from '../state/asset-loads';
import { missingTextureCanvas, missingTextureUrl } from '../viewport/missing-texture';

const urls = new Map<string, Promise<string>>();
export function versionedAssetUrl(url: string): boolean {
  const value = new URL(url, globalThis.location?.origin ?? 'http://localhost');
  return !!parseAssetVersion(value.searchParams.get('level') ?? '');
}

function workspaceImage(url: string): boolean {
  if (versionedAssetUrl(url)) return true;
  const value = new URL(url, globalThis.location?.origin ?? 'http://localhost');
  return (
    value.origin === globalThis.location?.origin &&
    value.pathname.startsWith('/api/') &&
    (value.searchParams.get('mapSource') === 'local' || /^local:/i.test(value.searchParams.get('level') ?? ''))
  );
}

/** Local and versioned images use the workspace transport; local files can be read only when requested. */
export function imageAssetUrl(url: string): Promise<string> {
  if (!workspaceImage(url)) return Promise.resolve(url);
  let pending = urls.get(url);
  if (!pending) {
    pending = (async () => {
      const response = await workspaceFetch(url);
      if (!response.ok) {
        const error = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(error.error ?? 'Matching texture version is unavailable.');
      }
      return URL.createObjectURL(await response.blob());
    })();
    urls.set(url, pending);
    void pending.catch(() => {
      if (urls.get(url) === pending) urls.delete(url);
    });
  }
  return pending;
}

const imageRequests = new WeakMap<HTMLImageElement, () => void>();
export function setImageAsset(image: HTMLImageElement, url: string): void {
  imageRequests.get(image)?.();
  let active = true,
    failed = false;
  const cleanup = () => {
    active = false;
    image.removeEventListener('load', loaded);
    image.removeEventListener('error', missing);
  };
  const loaded = () => {
    if (!failed) reportTextureLoad(url, 'ready');
    cleanup();
  };
  const missing = () => {
    if (failed) {
      cleanup();
      return;
    }
    failed = true;
    reportTextureLoad(url, 'missing');
    image.dataset.missingAsset = 'true';
    image.src = missingTextureUrl();
  };
  imageRequests.set(image, cleanup);
  delete image.dataset.missingAsset;
  image.addEventListener('load', loaded);
  image.addEventListener('error', missing);
  reportTextureLoad(url, 'loading');
  if (!workspaceImage(url)) image.src = url;
  else
    void imageAssetUrl(url)
      .then(value => {
        if (active) image.src = value;
      })
      .catch(() => {
        if (active) image.dispatchEvent(new Event('error'));
      });
}

export function setAssetBackground(element: HTMLElement, url: string): void {
  const image = new Image();
  image.onload = () => {
    element.style.backgroundImage = `url("${image.src}")`;
  };
  setImageAsset(image, url);
}

export function loadAssetTexture(
  loader: THREE.TextureLoader,
  url: string,
  onLoad?: (texture: THREE.Texture<CanvasImageSource>) => void,
  onProgress?: (event: ProgressEvent) => void,
  onError?: (error: unknown, texture: THREE.Texture<CanvasImageSource>) => void,
): THREE.Texture<CanvasImageSource> {
  reportTextureLoad(url, 'loading');
  const loaded = (texture: THREE.Texture<CanvasImageSource>) => {
    reportTextureLoad(url, 'ready');
    onLoad?.(texture);
  };
  const missing = (error: unknown) => {
    texture.image = missingTextureCanvas();
    texture.userData.missingAsset = true;
    texture.needsUpdate = true;
    reportTextureLoad(url, 'missing');
    onError?.(error, texture);
  };
  const texture: THREE.Texture<CanvasImageSource> = workspaceImage(url)
    ? new THREE.Texture<CanvasImageSource>()
    : loader.load(url, loaded, onProgress, missing);
  if (!workspaceImage(url)) return texture;
  const image = new Image();
  loader.manager.itemStart(url);
  image.onload = () => {
    texture.image = image;
    texture.needsUpdate = true;
    loaded(texture);
    loader.manager.itemEnd(url);
  };
  image.onerror = error => {
    missing(error);
    loader.manager.itemError(url);
    loader.manager.itemEnd(url);
  };
  void imageAssetUrl(url)
    .then(value => {
      image.src = value;
    })
    .catch(() => image.dispatchEvent(new Event('error')));
  return texture;
}
