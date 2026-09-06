import {
  request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse,
} from 'node:http';
import { connect as netConnect } from 'node:net';
import type { Duplex } from 'node:stream';
import { authorityRefusal, authorizeRequest, crossSiteRefusal } from './accounts/guard';
import { voiceConfig } from './api/voice';
import { accessFor, SAFE_METHODS } from './app';
import { createLogger } from './log';

/**
 * The public LiveKit signal URL sits under Slopesmith's existing `/api` reverse proxy. Media still travels
 * directly over LiveKit's advertised UDP/TCP ports; this small loopback proxy carries only its HTTP/WebSocket
 * signalling and avoids requiring a second TLS virtual host on every Slopesmith installation.
 *
 * It is gated the way the session channel is: the origin a page cannot hide, then the same cookie and the same
 * table (`ROUTE_ACCESS`) every `/api/*` route goes through. LiveKit validates its own token on the far side;
 * this asks the nearer question — a member of this server at all? — so an anonymous caller cannot use this
 * port to probe the signalling listener. On a server with no accounts the caller is the owner and nothing is
 * asked, which is what a loopback dev setup should look like.
 */
export const VOICE_PROXY_PATH = '/api/livekit';
const DEFAULT_UPSTREAM = 'http://127.0.0.1:7880';
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const log = createLogger('voice');

function matches(pathname: string): boolean {
  return pathname === VOICE_PROXY_PATH || pathname.startsWith(`${VOICE_PROXY_PATH}/`);
}

function upstream(): URL | null {
  if (!voiceConfig()) return null;
  const raw = process.env.SLOPESMITH_LIVEKIT_UPSTREAM?.trim() || DEFAULT_UPSTREAM;
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { throw new Error('SLOPESMITH_LIVEKIT_UPSTREAM must be a valid loopback http:// URL'); }
  if (parsed.protocol !== 'http:' || !LOOPBACK.has(parsed.hostname) || parsed.username || parsed.password
    || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new Error('SLOPESMITH_LIVEKIT_UPSTREAM must be a loopback http:// URL without a path or credentials');
  }
  return parsed;
}

function targetPath(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!matches(url.pathname)) return null;
  const relative = url.pathname.slice(VOICE_PROXY_PATH.length) || '/';
  return `${relative}${url.search}`;
}

function answer(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'private, no-store');
  res.end(JSON.stringify(body));
}

/** Proxy an ordinary LiveKit validation/signalling request. Returns false when this is not its path. */
export function proxyVoiceRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const path = targetPath(req);
  if (path === null) return false;
  let destination: URL | null;
  try { destination = upstream(); }
  catch (error) {
    log.error('invalid signalling proxy configuration', { error });
    answer(res, 503, { error: 'Voice signalling is not configured correctly.' });
    return true;
  }
  if (!destination) {
    answer(res, 503, { error: 'Voice chat is not configured on this server.' });
    return true;
  }

  // The path is claimed now; who may use it is settled behind that claim. The request body stays paused in
  // the meantime, so nothing is read or relayed before the caller is known.
  const method = req.method ?? 'GET';
  void (async () => {
    const crossSite = SAFE_METHODS.has(method) ? null : crossSiteRefusal(req);
    if (crossSite) { answer(res, crossSite.status, crossSite.body); return; }
    const decision = await authorizeRequest(req, accessFor(VOICE_PROXY_PATH)(method, path));
    if (!decision.allowed) { answer(res, decision.status, decision.body); return; }
    relay(req, res, destination, path);
  })().catch(error => {
    log.error('a signalling request failed', { error });
    if (!res.headersSent && !res.destroyed) answer(res, 500, { error: 'Voice signalling could not be reached.' });
    else res.destroy();
  });
  return true;
}

function relay(req: IncomingMessage, res: ServerResponse, destination: URL, path: string): void {
  const headers: IncomingHttpHeaders = { ...req.headers, host: destination.host };
  delete headers.connection;
  delete headers.upgrade;
  delete headers['proxy-connection'];
  const outgoing = httpRequest({
    hostname: destination.hostname,
    port: destination.port || 80,
    method: req.method,
    path,
    headers,
  }, incoming => {
    if (res.destroyed) { incoming.destroy(); return; }
    res.writeHead(incoming.statusCode ?? 502, incoming.statusMessage, incoming.headers);
    incoming.pipe(res);
  });
  outgoing.setTimeout(20_000, () => outgoing.destroy(new Error('LiveKit signalling timed out')));
  outgoing.on('error', error => {
    if (!res.headersSent && !res.destroyed) answer(res, 502, { error: 'Voice signalling is unavailable.' });
    else res.destroy(error);
  });
  req.on('aborted', () => outgoing.destroy());
  req.pipe(outgoing);
}

const REASON: Record<number, string> = {
  401: 'Unauthorized', 403: 'Forbidden', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
};

function refuseUpgrade(socket: Duplex, status: number, message: string): void {
  const body = JSON.stringify({ error: message });
  socket.end(`HTTP/1.1 ${status} ${REASON[status] ?? 'Bad Request'}\r\nconnection: close\r\n`
    + `content-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

/** Re-serialize the browser's already-parsed upgrade request to the loopback LiveKit listener. */
async function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  const path = targetPath(req);
  if (path === null) return;
  const authority = authorityRefusal(req);
  if (authority) { refuseUpgrade(socket, authority.status, String(authority.body.error)); return; }
  let destination: URL | null;
  try { destination = upstream(); }
  catch (error) {
    log.error('invalid signalling proxy configuration', { error });
    refuseUpgrade(socket, 503, 'Voice signalling is not configured correctly.');
    return;
  }
  if (!destination) {
    refuseUpgrade(socket, 503, 'Voice chat is not configured on this server.');
    return;
  }
  // The upgrade carries the same cookie a fetch would, so it is gated the same way the session channel's is.
  const crossSite = crossSiteRefusal(req);
  if (crossSite) { refuseUpgrade(socket, crossSite.status, String(crossSite.body.error)); return; }
  const decision = await authorizeRequest(req, accessFor(VOICE_PROXY_PATH)('GET', path));
  if (!decision.allowed) { refuseUpgrade(socket, decision.status, String(decision.body.error ?? 'Refused.')); return; }
  if (socket.destroyed) return;

  const peer = netConnect(Number(destination.port || 80), destination.hostname);
  let connected = false;
  peer.setNoDelay(true);
  peer.once('connect', () => {
    connected = true;
    const lines = [`${req.method ?? 'GET'} ${path} HTTP/${req.httpVersion}`, `Host: ${destination!.host}`];
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      const name = req.rawHeaders[index];
      if (name.toLowerCase() === 'host' || name.toLowerCase() === 'proxy-connection') continue;
      lines.push(`${name}: ${req.rawHeaders[index + 1]}`);
    }
    peer.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) peer.write(head);
    socket.pipe(peer);
    peer.pipe(socket);
  });
  peer.once('error', () => {
    if (!connected && !socket.destroyed) refuseUpgrade(socket, 502, 'Voice signalling is unavailable.');
    else socket.destroy();
  });
  socket.once('error', () => peer.destroy());
  socket.once('close', () => peer.destroy());
}

/** Attach only the upgrade half; ordinary requests enter through the service's existing HTTP callback. */
export function attachVoiceProxy(server: Server): () => void {
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    void proxyUpgrade(req, socket, head).catch(error => {
      log.error('a signalling upgrade failed', { error });
      try { refuseUpgrade(socket, 500, 'Voice signalling could not be opened.'); } catch { socket.destroy(); }
    });
  };
  server.on('upgrade', upgrade);
  return () => server.off('upgrade', upgrade);
}
