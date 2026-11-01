const KEY = 'slopesmith.mountainImportNotice';

/** Carry missing-asset feedback across the main-page → editor navigation in this tab. */
export function rememberMountainImport(projectId: string, missing: string[]): void {
  try {
    if (missing.length) sessionStorage.setItem(KEY, JSON.stringify({ projectId, missing }));
    else sessionStorage.removeItem(KEY);
  } catch {
    /* Optional feedback must not block a successful import. */
  }
}

export function takeMountainImportNotice(projectId: string | undefined): string[] {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as {
      projectId?: unknown;
      missing?: unknown;
    } | null;
    if (!projectId || value?.projectId !== projectId) return [];
    sessionStorage.removeItem(KEY);
    return Array.isArray(value.missing) ? value.missing.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
