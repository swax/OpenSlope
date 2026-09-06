import { AccessToken, TrackSource } from 'livekit-server-sdk';
import type { ApiRequest } from './request';
import { createLogger } from '../log';
import { colorFor } from '../session/presence';
import { jsonResponse, type ApiHandler } from './common';

const log = createLogger('voice');

/**
 * LiveKit is deliberately optional. A local Slopesmith remains a self-contained editor, while a hosted
 * server enables voice by supplying all three values through its root-owned environment file.
 */
export interface VoiceConfig {
  serverUrl: string;
  apiKey: string;
  apiSecret: string;
  roomName: string;
}

// The token rides the signalling URL and can therefore appear in reverse-proxy access logs. LiveKit refreshes
// a connected participant's token; fifteen minutes is ample for joining without leaving a reusable room key.
const TOKEN_TTL = '15m';
const MAX_CLIENT_ID = 64;
/** Backward-compatible room for installations that have not chosen their own deployment namespace. */
export const DEFAULT_VOICE_ROOM_NAME = 'slopesmith-server';
const ROOM_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
let reportedPartialConfig = false;

/** Read at request time so a test or an embedding process can configure the optional service before start. */
export function voiceConfig(): VoiceConfig | null {
  const serverUrl = process.env.SLOPESMITH_LIVEKIT_URL?.trim() ?? '';
  const apiKey = process.env.SLOPESMITH_LIVEKIT_API_KEY?.trim() ?? '';
  const apiSecret = process.env.SLOPESMITH_LIVEKIT_API_SECRET?.trim() ?? '';
  const roomName = process.env.SLOPESMITH_LIVEKIT_ROOM?.trim() || DEFAULT_VOICE_ROOM_NAME;
  if (!serverUrl && !apiKey && !apiSecret) return null;
  if (!serverUrl || !apiKey || !apiSecret) {
    if (!reportedPartialConfig) {
      reportedPartialConfig = true;
      log.warn('LiveKit configuration is incomplete; URL, API key, and API secret are all required.');
    }
    return null;
  }

  let parsed: URL;
  try { parsed = new URL(serverUrl); }
  catch { throw new Error('SLOPESMITH_LIVEKIT_URL must be a valid ws:// or wss:// URL'); }
  if ((parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') || parsed.username || parsed.password
    || parsed.search || parsed.hash) {
    throw new Error('SLOPESMITH_LIVEKIT_URL must be a ws:// or wss:// URL without credentials, query, or hash');
  }
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'wss:') {
    throw new Error('SLOPESMITH_LIVEKIT_URL must use wss:// in production');
  }
  if (!ROOM_NAME_PATTERN.test(roomName)) {
    throw new Error('SLOPESMITH_LIVEKIT_ROOM must be 1-128 letters, numbers, dots, underscores, colons, or hyphens');
  }
  return { serverUrl: parsed.toString().replace(/\/$/, ''), apiKey, apiSecret, roomName };
}

function requestClientId(req: ApiRequest): string {
  const raw = req.headers['x-slopesmith-client'];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
  if (!value || value.length > MAX_CLIENT_ID || !/^[a-zA-Z0-9._:-]+$/.test(value)) {
    throw new Error('Voice chat needs this browser tab\'s valid client id.');
  }
  return value;
}

export const voiceRoutes: Record<string, ApiHandler> = {
  '/api/voice': async (incoming, res) => {
    const req = incoming as ApiRequest;
    res.setHeader('cache-control', 'private, no-store');
    try {
      const config = voiceConfig();
      if (req.method === 'GET') {
        jsonResponse(res, 200, { enabled: !!config });
        return;
      }
      if (req.method !== 'POST') { res.statusCode = 405; res.end('GET or POST only'); return; }
      if (!config) {
        jsonResponse(res, 503, { error: 'Voice chat is not configured on this server.' });
        return;
      }
      // Personal API keys are for programs. A voice participant must be the signed-in browser identity that
      // the room will show to other people, not a bearer secret copied into an arbitrary client.
      const identity = req.identity;
      if (!identity || (identity.kind !== 'owner' && identity.kind !== 'member')) {
        jsonResponse(res, 403, { error: 'Voice chat is available to signed-in browser sessions.' });
        return;
      }

      const clientId = requestClientId(req);
      const user = identity.user;
      const token = new AccessToken(config.apiKey, config.apiSecret, {
        identity: `${user.id}:${clientId}`,
        name: user.username,
        ttl: TOKEN_TTL,
        attributes: {
          'slopesmith.userId': user.id,
          'slopesmith.username': user.username,
          'slopesmith.role': user.role,
          'slopesmith.clientId': clientId,
          'slopesmith.color': colorFor(user.id),
        },
      });
      token.addGrant({
        room: config.roomName,
        roomJoin: true,
        canSubscribe: true,
        canPublish: true,
        canPublishSources: [TrackSource.MICROPHONE],
        canPublishData: false,
      });
      jsonResponse(res, 200, {
        serverUrl: config.serverUrl,
        participantToken: await token.toJwt(),
        roomName: config.roomName,
      });
    } catch (error) {
      jsonResponse(res, 400, { error: String(error instanceof Error ? error.message : error) });
    }
  },
};
