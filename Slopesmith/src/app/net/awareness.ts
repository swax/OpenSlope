import type { Awareness } from './session-channel';

/**
 * What this participant is doing, told to the room (docs/039).
 *
 * Free-for-all editing works in practice because people can see each other: live selections and a soft
 * highlight on whatever somebody is holding avoid nearly every collision socially, far more cheaply than any
 * locking scheme. Screen-share cursors use their observer-only stream instead of this room-wide channel.
 *
 * So a frame names two things at once. What this tab has PICKED, which is the selection; and what it is
 * WRITING, which the register sync reads back off its own assignments. The second is what makes a paint
 * stroke visible: a stroke clears the paint selection on its first face and then writes tiles, so there is
 * nothing selected to report and the faces being painted are the whole of what is happening.
 *
 * ## Sent on change, never on a tick
 *
 * The interval is a rate LIMIT, not a heartbeat. A frame goes out only when what it would say differs from
 * what the room was last told, so a tab that is merely rendering — somebody else's drag arriving, a settle
 * pass, an idle editor with nothing picked — says nothing at all, for as long as that stays true. A session
 * opens with empty awareness on the server, so that is what this starts out believing the room holds and an
 * editor that touches nothing never sends a frame at all.
 */

/**
 * How often a frame may be sent: 12.5 Hz.
 *
 * Awareness is drawn for a person to glance at rather than composited into geometry, and 80 ms is under the
 * threshold at which a mark reads as lagging the hand it belongs to while costing a fraction of the register
 * stream beside it. It also sets how long a state has to stand to be worth telling anybody about: a selection
 * made and dropped inside one period was never a selection anybody could have reacted to.
 */
export const AWARE_MS = 80;

/** What a tab sends: the awareness it owns, without the arrival time the server stamps on. */
export type AwarenessFrame = Omit<Awareness, 'at'>;

const EMPTY: AwarenessFrame = { cursor: null, vertices: [], quads: [], dragging: [], player: null };

export function createAwareness(deps: {
  /** What this tab has picked by hand — corners and faces, named the way the document names them. */
  selection: () => { vertices: string[]; quads: string[] };
  /** What its own assignments are naming right now, and which of that the room has yet to acknowledge
   *  (`register-sync.ts`). */
  editing: () => { vertices: string[]; quads: string[]; dragging: string[] };
  /** Legacy protocol slot. The editor sends null; shared-screen frames carry observer-only cursors. */
  cursor: () => [number, number, number] | null;
  /** Camera/body pose in the scene, including tracked head/hands while WebXR has them. */
  player: () => AwarenessFrame['player'];
  /** Send one. False when the socket is not up, which is what keeps a frame nobody received from being
   *  remembered as one the room has been told. */
  send: (aware: AwarenessFrame) => boolean;
}) {
  /** What the room was last told, as the text a comparison is one string. */
  let said = JSON.stringify(EMPTY);
  let ticker: ReturnType<typeof setInterval> | null = null;
  let periodMs = AWARE_MS;

  const frame = (): AwarenessFrame => {
    const picked = deps.selection(), live = deps.editing();
    return {
      cursor: deps.cursor(),
      vertices: [...new Set([...picked.vertices, ...live.vertices])],
      quads: [...new Set([...picked.quads, ...live.quads])],
      dragging: live.dragging,
      player: deps.player(),
    };
  };

  /** Say what this tab is doing, if it has changed. */
  function publish(): void {
    const aware = frame();
    const text = JSON.stringify(aware);
    if (text === said || !deps.send(aware)) return;
    said = text;
  }

  const arm = (): void => {
    ticker = setInterval(publish, periodMs);
    (ticker as { unref?: () => void }).unref?.();
  };

  return {
    /** Start saying so. The interval is the only timer this module owns. */
    start(): void {
      if (ticker) return;
      arm();
    },
    stop(): void {
      if (ticker) clearInterval(ticker);
      ticker = null;
    },
    publish,
    /** Follow the server's room-size policy. Never publish faster than the editor's normal 12.5 Hz ceiling. */
    setPeriod(ms: number): void {
      const next = Math.max(AWARE_MS, Math.min(1_000, Math.round(ms)));
      if (!Number.isFinite(next) || next === periodMs) return;
      periodMs = next;
      if (!ticker) return;
      clearInterval(ticker);
      arm();
    },
    period: (): number => periodMs,
    /** The room has forgotten what this tab said — a map it left, or a socket it lost. Both leave the server
     *  holding empty awareness for this session, so that is what has to be believed of it again. */
    reset(): void { said = JSON.stringify(EMPTY); },
  };
}

export type AwarenessPublisher = ReturnType<typeof createAwareness>;
