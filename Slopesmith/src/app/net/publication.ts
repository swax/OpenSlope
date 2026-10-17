import { clientFetch } from './client';
import type { PublicCourseKind } from '../../core/session/public-courses';

export { publicProjectUrl } from '../public/links';

/** Publication API shared by Map permissions and reference map listing controls. */
export async function coursePublication(kind: PublicCourseKind, id: string, published?: boolean): Promise<boolean> {
  const response = await clientFetch(
    `/api/publication?kind=${kind}&id=${encodeURIComponent(id)}`,
    published === undefined
      ? undefined
      : { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ published }) },
  );
  const result = (await response.json()) as { published: boolean; error?: string };
  if (!response.ok) throw new Error(result.error ?? 'The publication settings could not be saved.');
  return result.published;
}
