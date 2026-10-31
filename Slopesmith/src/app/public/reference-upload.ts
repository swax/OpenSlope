import { canonicalDiscCourse } from '../../core/reference/disc-courses';
import { sha256 } from '../../shared/map-asset-version';
import {
  REFERENCE_CHUNK_BYTES,
  referenceManifest,
  type ServerReference,
  type ReferenceUploadPlan,
} from '../../shared/reference-transfer';
import { cachedCourseFiles } from './iso-cache';
import { referenceMusicEncoder } from './reference-music-encoder';
import { prepareReferenceMusic } from './reference-music-preparation';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/reference-maps${path}`, {
    ...options,
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000),
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Reference request failed (${response.status}).`);
  return data;
}

export const listServerReferences = () => request<{ maps: ServerReference[] }>('');
export const removeReference = (name: string, signal: AbortSignal) =>
  request(`/maps/${encodeURIComponent(name)}`, { method: 'DELETE', signal });
export const referenceForCourse = (maps: readonly ServerReference[], course: string): ServerReference | undefined =>
  maps.find(map => canonicalDiscCourse(map.course.toUpperCase()) === canonicalDiscCourse(course.toUpperCase()));

/** No ISO is read or uploaded. Already extracted Blobs are hashed and streamed in bounded binary slices. */
export async function uploadReference(course: string, signal: AbortSignal, progress: (message: string) => void) {
  progress('Preparing reference files…');
  const files = await cachedCourseFiles(course);
  referenceManifest({
    course: canonicalDiscCourse(course.toUpperCase()),
    music: true,
    files: files.map(file => ({ path: file.path, size: file.blob.size, sha256: '0'.repeat(64) })),
  });
  const manifestFiles = [];
  for (const file of files) {
    signal.throwIfAborted();
    manifestFiles.push({
      path: file.path,
      size: file.blob.size,
      sha256: await sha256(new Uint8Array(await file.blob.arrayBuffer())),
      blob: file.blob,
    });
  }
  const encoder = referenceMusicEncoder(signal);
  try {
    const prepared = await prepareReferenceMusic(
      manifestFiles,
      hashes =>
        request('/music', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ hashes }),
          signal,
        }),
      blob => encoder.encode(blob),
      signal,
      progress,
    );
    for (;;) {
      const files = await prepared.files();
      const manifest = referenceManifest({
        course: canonicalDiscCourse(course.toUpperCase()),
        music: true,
        reuse: true,
        files,
      });
      signal.throwIfAborted();
      progress('Checking the server for matching files…');
      const upload = await request<ReferenceUploadPlan>('/uploads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(manifest),
        signal,
      });
      const path = `/uploads/${upload.id}`;
      let complete = false;
      try {
        const selected = upload.missing ?? files.map((_file, index) => index);
        if (
          selected.some(index => !Number.isInteger(index) || index < 0 || index >= files.length) ||
          new Set(selected).size !== selected.length
        )
          throw new Error('The server returned an invalid reference upload plan.');
        if (selected.some(index => !files[index].blob)) {
          await request(path, { method: 'DELETE', signal });
          await prepared.materialize(selected);
          continue;
        }
        const content = new Blob(selected.map(index => files[index].blob!));
        const reused = upload.reusedFiles ? `${upload.reusedFiles} files reused · ` : '';
        let offset = 0;
        while (offset < content.size) {
          const end = Math.min(offset + REFERENCE_CHUNK_BYTES, content.size);
          progress(`${reused}Uploading reference… ${Math.floor((offset / content.size) * 100)}%`);
          try {
            const result = await request<{ offset: number }>(`${path}?offset=${offset}`, {
              method: 'PUT',
              headers: { 'content-type': 'application/octet-stream' },
              body: content.slice(offset, end),
              signal,
            });
            offset = result.offset;
          } catch (error) {
            signal.throwIfAborted();
            // The server may have accepted the chunk before its reply was lost. Never append it twice.
            const status = await request<{ offset: number }>(path, { signal });
            if (status.offset <= offset) throw error;
            offset = status.offset;
          }
        }
        progress('Validating reference on the server…');
        const result = await request<ServerReference>(`${path}/complete`, { method: 'POST', signal });
        complete = true;
        return {
          ...result,
          reusedFiles: upload.reusedFiles ?? 0,
          reusedBytes: upload.reusedBytes ?? 0,
          uploadedBytes: content.size,
        };
      } finally {
        if (!complete) await request(path, { method: 'DELETE' }).catch(() => {});
      }
    }
  } finally {
    encoder.close();
  }
}
