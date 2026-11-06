import type { ChildProcess, SpawnOptions } from 'node:child_process';
export function stopProcessTree(child: ChildProcess): void;
export function runProcess(
  command: string,
  args: string[],
  options: SpawnOptions & { timeout: number },
): Promise<{ status: number | null; error?: Error & { code?: string } }>;
