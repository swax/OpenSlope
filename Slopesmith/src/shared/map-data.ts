/** Shared reader for server files and browser-local ISO extractions. Paths are logical map paths. */
export interface MapDataSource {
  root: string;
  readJsonOr<T>(path: string, fallback: T): Promise<T>;
  readTextOrNull(path: string): Promise<string | null>;
  listDir(path: string): Promise<string[]>;
  listEntries(path: string): Promise<Array<{ name: string; isDirectory: boolean }>>;
  pathExists(path: string): Promise<boolean>;
  readBytesOrNull(path: string): Promise<Uint8Array | null>;
}
export const READ_CONCURRENCY = 8;
export const joinMapPath = (...parts: string[]) => parts.filter(Boolean).join('/');
export const mapBasename = (path: string) => path.replace(/\\/g, '/').split('/').at(-1) ?? '';
export { safeDataName as safeMapName } from '../core/export/names';
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(items.length, limit) }, async () => {
      while (next < items.length) {
        const index = next++;
        result[index] = await fn(items[index]);
      }
    }),
  );
  return result;
}
