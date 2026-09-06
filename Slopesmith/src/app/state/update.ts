import { fetchJson, postJson } from '../net/fetch-json';

export type UpdateState = 'queued' | 'installing' | 'succeeded' | 'failed';

export interface UpdateStatus {
  available: boolean;
  /** The credential-free Git source selected by this server. Available only from the admin route. */
  repository?: string;
  reason?: string;
  state?: UpdateState;
  revision?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
}

export interface QueuedUpdate { queued: true; revision: string }

export const loadUpdateStatus = (): Promise<UpdateStatus> => fetchJson('/api/update');
export const requestUpdate = (target: 'latest' | string): Promise<QueuedUpdate> =>
  postJson('/api/update', JSON.stringify({ target }));
