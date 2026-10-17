/** Child-process load generator for the local integration benchmark. Credentials never enter logs/argv. */
import { playSocket } from '../test/play-socket';
import type { TicketRequest, TicketResponse } from '../src/core/session/play-protocol.generated';

const api = process.env.SLOPESMITH_LOAD_API!;
const courseId = process.env.SLOPESMITH_LOAD_COURSE!;
const cookie = process.env.SLOPESMITH_LOAD_COOKIE!;
const socketUrl = process.env.SLOPESMITH_LOAD_SOCKET!;
if (!process.send || !api || !courseId || !cookie || !socketUrl)
  throw new Error('Run this generator through multiplayer:bench.');
const sockets: Awaited<ReturnType<typeof playSocket>>[] = [];
try {
  for (let i = 0; i < 100; i++) {
    const request: TicketRequest = {
      courseId,
      roomId: `load-${i % 4}`,
      clientId: `load-${i}`,
      deviceLabel: 'load',
      publicPlay: true,
    };
    const response = await fetch(`${api}/api/play/ticket`, {
      method: 'POST',
      headers: { origin: api, cookie, 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`Load admission failed (${response.status}).`);
    const ticket = (await response.json()) as TicketResponse;
    const socket = await playSocket(socketUrl, { origin: api, compressed: true });
    sockets.push(socket);
    socket.send({ t: 'hello', protocol: 1, ticket: ticket.ticket });
    await socket.expect(message => message.t === 'welcome');
  }
  let seq = 0;
  for (const players of [0, 10, 25, 50, 100]) {
    const publish = () => {
      seq++;
      for (let i = 0; i < players; i++)
        sockets[i].send({
          t: 'pose',
          player: {
            version: 2,
            seq,
            sampleAt: Date.now(),
            teleport: 0,
            mode: 'ride',
            vr: false,
            avatar: 'procedural',
            body: { p: [seq, i, 0], q: [0, 0, 0, 1] },
            velocity: [10, 0, 0],
            equipment: {
              state: 'mounted',
              transform: { p: [seq, i, 0], q: [0, 0, 0, 1] },
              velocity: [10, 0, 0],
              teleport: 0,
            },
          },
        });
    };
    const timer = setInterval(publish, 80);
    publish();
    process.send({ players });
    await new Promise<void>(resolve => process.once('message', () => resolve()));
    clearInterval(timer);
  }
} finally {
  for (const socket of sockets) socket.close();
  process.disconnect();
}
