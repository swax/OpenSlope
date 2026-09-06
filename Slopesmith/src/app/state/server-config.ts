/** The machine-local paths, as the local server reports them. Field names match the bootstrap record. */
export interface ServerWorkspaceConfig {
  workspaceRoot: string;
  /** Reference maps are read from here, and it is the folder an export is written into. */
  mapsRoot: string;
  appRoot: string;
  configFile: string;
  configured: boolean;
  /** Concurrent account seats in the session channel. Admin accounts may exceed this soft limit. */
  maxPlayers: number;
  /** Fields the environment owns: shown read-only and left out of what Settings writes. */
  overrides: Record<ServerConfigField, boolean>;
  /** The variable names actually in force. */
  overrideVars: string[];
}

export type PathField = 'workspaceRoot' | 'mapsRoot';
export type ServerConfigField = PathField | 'maxPlayers';

/** Only the fields the dialog may edit are sent; an omitted one keeps whatever the server already holds. */
export type ServerWorkspacePatch = Partial<Record<PathField, string>> & { maxPlayers?: number };

export interface ServerWorkspaceView {
  config: ServerWorkspaceConfig;
}

async function errorFrom(res: Response): Promise<Error> {
  try {
    const body = await res.json() as { error?: string };
    return new Error(body.error || `${res.status} ${res.statusText}`);
  } catch { return new Error(`${res.status} ${res.statusText}`); }
}

/** Read the machine-local paths. */
export async function loadServerWorkspaceConfig(): Promise<ServerWorkspaceView> {
  const res = await fetch('/api/config');
  if (!res.ok) throw await errorFrom(res);
  return await res.json() as ServerWorkspaceView;
}

export async function saveServerWorkspaceConfig(patch: ServerWorkspacePatch): Promise<{
  config: ServerWorkspaceConfig;
  restartRequired: boolean;
}> {
  const res = await fetch('/api/config', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
  });
  if (!res.ok) throw await errorFrom(res);
  return await res.json() as { config: ServerWorkspaceConfig; restartRequired: boolean };
}
