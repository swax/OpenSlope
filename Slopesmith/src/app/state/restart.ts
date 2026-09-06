import { fetchJson, postJson } from '../net/fetch-json';

export interface ServerRestartStatus {
  available: boolean;
  /** Identifies one constructed API service and changes after its startup path runs again. */
  instance?: string;
  reason?: string;
}

export interface AcceptedServerRestart {
  restarting: true;
  instance: string;
}

export const loadServerRestartStatus = (): Promise<ServerRestartStatus> =>
  fetchJson('/api/restart', { cache: 'no-store' });
export const requestServerRestart = (): Promise<AcceptedServerRestart> => postJson('/api/restart');
