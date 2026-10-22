import type { Plugin } from 'vite';
export function offlinePlugin(): Plugin;
export function writeOfflineWorker(directory: string): Promise<void>;
