import type { Metafile } from 'esbuild';
import type { Plugin } from 'vite';

export const BROWSER_INVENTORY: string;
export const BROWSER_NOTICE_ASSET: string;
export const VIRTUAL_NOTICE_ID: string;

export interface InstalledPackageRecord {
  root: string;
  path: string;
  name: string;
  version: string;
  license: string;
  manifest: Record<string, unknown>;
  legalFiles: string[];
}

export function readDependencyPolicy(appRoot: string): Promise<{
  manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  browser: Set<string>;
  server: Set<string>;
  development: Set<string>;
}>;
export function packageRootFromModuleId(moduleId: string): string | null;
export function recordsFromModuleIds(moduleIds: Iterable<string>, appRoot: string): Promise<InstalledPackageRecord[]>;
export function inventoryDocument(records: InstalledPackageRecord[]): Record<string, unknown>;
export function renderInstalledNotices(records: InstalledPackageRecord[], heading: string): Promise<string>;
export function installedDependencyClosure(appRoot: string, directNames: Iterable<string>): Promise<InstalledPackageRecord[]>;
export function externalPackageNames(metafile: Metafile): Set<string>;
export function assertPolicyCategory(label: string, actual: Iterable<string>, expected: Iterable<string>): void;
export function dependencyNoticesPlugin(appRoot: string): Plugin;
