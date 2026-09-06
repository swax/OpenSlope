import { fetchJson, postJson } from '../net/fetch-json';

export interface GitRevision {
  hash: string;
  committedAt?: string;
  subject?: string;
}

export type VersionRelation = 'current' | 'behind' | 'ahead' | 'diverged' | 'unknown';

export interface AppVersionInfo {
  available: boolean;
  current?: GitRevision;
  branch?: string;
  dirty?: boolean;
  reason?: string;
  latest?: GitRevision;
  latestBranch?: string;
  relation?: VersionRelation;
  ahead?: number;
  behind?: number;
  checkedAt?: string;
  checkError?: string;
}

export const loadAppVersion = (): Promise<AppVersionInfo> => fetchJson('/api/version');
export const checkAppVersion = (): Promise<AppVersionInfo> => postJson('/api/version');
