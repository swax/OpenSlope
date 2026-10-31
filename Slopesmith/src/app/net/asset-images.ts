import * as THREE from 'three';
import { parseAssetVersion } from '../../core/reference/asset-version';
import { workspaceFetch } from './workspace';

const urls = new Map<string, Promise<string>>();
export function versionedAssetUrl(url: string): boolean {
  const value = new URL(url, globalThis.location?.origin ?? 'http://localhost');
  return !!parseAssetVersion(value.searchParams.get('level') ?? '');
}

/** Versioned images go through the same content-checked local/server transport as JSON and exports. */
export function imageAssetUrl(url: string): Promise<string> {
  if (!versionedAssetUrl(url)) return Promise.resolve(url);
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

export function setImageAsset(image: HTMLImageElement, url: string): void {
  if (!versionedAssetUrl(url)) {
    image.src = url;
    return;
  }
  void imageAssetUrl(url)
    .then(value => {
      image.src = value;
    })
    .catch(() => image.dispatchEvent(new Event('error')));
}

export function setAssetBackground(element: HTMLElement, url: string): void {
  if (!versionedAssetUrl(url)) {
    element.style.backgroundImage = `url(${url})`;
    return;
  }
  void imageAssetUrl(url)
    .then(value => {
      element.style.backgroundImage = `url(${value})`;
    })
    .catch(() => {
      element.style.backgroundImage = '';
    });
}

export function loadAssetTexture(
  loader: THREE.TextureLoader,
  url: string,
  onLoad?: (texture: THREE.Texture<HTMLImageElement>) => void,
  onProgress?: (event: ProgressEvent) => void,
  onError?: (error: unknown) => void,
): THREE.Texture<HTMLImageElement> {
  if (!versionedAssetUrl(url)) return loader.load(url, onLoad, onProgress, onError);
  const texture = new THREE.Texture<HTMLImageElement>();
  const image = new Image();
  loader.manager.itemStart(url);
  image.onload = () => {
    texture.image = image;
    texture.needsUpdate = true;
    onLoad?.(texture);
    loader.manager.itemEnd(url);
  };
  image.onerror = error => {
    onError?.(error);
    loader.manager.itemError(url);
    loader.manager.itemEnd(url);
  };
  setImageAsset(image, url);
  return texture;
}
