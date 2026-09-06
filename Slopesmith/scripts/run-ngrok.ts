import { spawn } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';

type TunnelName = 'local-server' | 'video-bridge';

const tunnels: Record<TunnelName, { port: number; urlVariable: string }> = {
  'local-server': { port: 5179, urlVariable: 'SLOPESMITH_LOCAL_SERVER_NGROK_URL' },
  'video-bridge': { port: 8085, urlVariable: 'SLOPESMITH_VIDEO_BRIDGE_NGROK_URL' },
};

const requested = process.argv[2];
if (requested !== 'local-server' && requested !== 'video-bridge') {
  throw new Error('Choose one ngrok tunnel: local-server or video-bridge.');
}

const envFile = resolve(process.cwd(), '.env');
try {
  loadEnvFile(envFile);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new Error(`Missing ${envFile}. Copy .env.example to .env and set the ngrok addresses.`, { cause: error });
  }
  throw error;
}

const tunnel = tunnels[requested];
const publicUrl = process.env[tunnel.urlVariable]?.trim();
if (!publicUrl) {
  throw new Error(`Set ${tunnel.urlVariable} in ${envFile} before starting this tunnel.`);
}

const ngrok = spawn('ngrok', ['http', String(tunnel.port), `--url=${publicUrl}`], {
  stdio: 'inherit',
  windowsHide: true,
});

process.exitCode = await new Promise<number>(resolveExit => {
  ngrok.once('error', error => {
    console.error(`Could not start ngrok: ${error.message}`);
    resolveExit(1);
  });
  ngrok.once('exit', code => resolveExit(code ?? 1));
});
