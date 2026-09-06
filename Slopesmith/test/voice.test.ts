/**
 * Voice credentials over the real authenticated HTTP path. The media server itself is intentionally not a
 * test dependency: this proves that Slopesmith chooses its one server room, derives the participant from the
 * guarded request, and signs a token that can publish a microphone but not camera, screen, or data.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenVerifier } from 'livekit-server-sdk';
import { expectOk, fetchForTest, removeTestTree } from './http-test-support';
import { check, failures } from './check';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-voice-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = root;
process.env.SLOPESMITH_MAPS_ROOT = root;
delete process.env.SLOPESMITH_LIVEKIT_URL;
delete process.env.SLOPESMITH_LIVEKIT_API_KEY;
delete process.env.SLOPESMITH_LIVEKIT_API_SECRET;
delete process.env.SLOPESMITH_LIVEKIT_ROOM;

const { forgetWorkspaceConfig } = await import('../src/server/workspace-config');
const { forgetAccounts } = await import('../src/server/accounts/store');
forgetWorkspaceConfig();
forgetAccounts();

const { startApiService } = await import('../src/server/main');
const { accessFor } = await import('../src/server/app');
const { DEFAULT_VOICE_ROOM_NAME } = await import('../src/server/api/voice');

let service: Awaited<ReturnType<typeof startApiService>> | undefined;
const api = (path: string): string => `${service!.url}${path}`;
const post = (path: string, client = 'tab-voice-test', body = '{}') => fetchForTest(api(path), {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-slopesmith-client': client },
  body,
});

try {
  service = await startApiService({ port: 0, host: '127.0.0.1' });

  const absent = await (await expectOk(fetchForTest(api('/api/voice')), 'reading disabled voice status')).json() as
    { enabled?: boolean };
  check(absent.enabled === false, 'a server without LiveKit configuration reports voice disabled');
  check((await post('/api/voice')).status === 503,
    'and refuses to mint a credential rather than falling back to a development secret');

  process.env.SLOPESMITH_LIVEKIT_URL = 'ws://127.0.0.1:7880/livekit';
  process.env.SLOPESMITH_LIVEKIT_API_KEY = 'slopesmith-test-key';
  process.env.SLOPESMITH_LIVEKIT_API_SECRET = 'slopesmith-test-secret-long-enough';
  const enabled = await (await expectOk(fetchForTest(api('/api/voice')), 'reading enabled voice status')).json() as
    { enabled?: boolean };
  check(enabled.enabled === true, 'supplying all three LiveKit settings enables voice');
  check(accessFor('/api/voice')('GET', '/') === 'viewer' && accessFor('/api/voice')('POST', '/') === 'viewer',
    'every member, including a read-only viewer, may join the conversation');

  check((await post('/api/voice', '', '{}')).status === 400,
    'a voice participant must carry the browser tab id used by the rest of Slopesmith');

  const issued = await (await expectOk(post('/api/voice', 'tab-voice-test',
    JSON.stringify({ roomName: 'caller-chosen-room', projectId: 'caller-chosen-project' })),
  'minting the server voice credential without an open mountain')).json() as {
      serverUrl: string; participantToken: string; roomName: string;
    };
  check(issued.serverUrl === 'ws://127.0.0.1:7880/livekit'
    && issued.roomName === DEFAULT_VOICE_ROOM_NAME && issued.participantToken.split('.').length === 3,
  'the browser receives the configured endpoint, default server room, and a JWT regardless of request fields');

  const claims = await new TokenVerifier(
    process.env.SLOPESMITH_LIVEKIT_API_KEY,
    process.env.SLOPESMITH_LIVEKIT_API_SECRET,
  ).verify(issued.participantToken);
  check(claims.sub === 'owner:tab-voice-test' && claims.name === 'owner'
    && claims.attributes?.['slopesmith.userId'] === 'owner',
  'the participant identity and username come from the guarded Slopesmith principal');
  check(claims.video?.roomJoin === true && claims.video.room === issued.roomName
    && claims.video.canSubscribe === true && claims.video.canPublishData === false,
  'the token joins and listens only to this server room, without a data-channel grant');
  check(claims.video?.canPublishSources?.length === 1
    && String(claims.video.canPublishSources[0]).toLowerCase() === 'microphone',
  'the only media source the token may publish is a microphone');

  process.env.SLOPESMITH_LIVEKIT_ROOM = 'slopesmith-test';
  const isolated = await (await expectOk(post('/api/voice', 'tab-isolated-room'),
    'minting a credential for a configured deployment room')).json() as {
      participantToken: string; roomName: string;
    };
  const isolatedClaims = await new TokenVerifier(
    process.env.SLOPESMITH_LIVEKIT_API_KEY,
    process.env.SLOPESMITH_LIVEKIT_API_SECRET,
  ).verify(isolated.participantToken);
  check(isolated.roomName === 'slopesmith-test' && isolatedClaims.video?.room === 'slopesmith-test',
    'the configured room isolates this Slopesmith deployment on a shared LiveKit server');

  process.env.SLOPESMITH_LIVEKIT_ROOM = 'invalid room name';
  check((await post('/api/voice', 'tab-invalid-room')).status === 400,
    'an unsafe deployment room name is rejected instead of entering a surprising LiveKit namespace');
} finally {
  if (service) await service.close();
  delete process.env.SLOPESMITH_LIVEKIT_URL;
  delete process.env.SLOPESMITH_LIVEKIT_API_KEY;
  delete process.env.SLOPESMITH_LIVEKIT_API_SECRET;
  delete process.env.SLOPESMITH_LIVEKIT_ROOM;
  removeTestTree(root);
}

if (failures) process.exitCode = 1;
