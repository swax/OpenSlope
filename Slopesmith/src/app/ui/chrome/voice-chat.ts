import type {
  Participant, RemoteParticipant, RemoteTrack, RemoteTrackPublication, Room as LiveKitRoom,
} from 'livekit-client';
import { fetchJson, postJson } from '../../net/fetch-json';
import { installStyles } from '../components/styles';

/**
 * Voice is server-wide: everybody who opts in joins one room regardless of which mountain they have open.
 * LiveKit carries only media; Slopesmith remains the authority for authentication, usernames, and access.
 *
 * The SDK is loaded on the first join rather than in the editor's initial bundle. A server with voice turned
 * off therefore pays one tiny status request and no WebRTC download, permission prompt, or audio work.
 */

const CSS = `
.sp-voice { display: flex; align-items: center; gap: 5px; width: fit-content;
  max-width: 100%; padding: 4px 5px; pointer-events: auto; color: #dbe7f2;
  background: rgba(12, 20, 29, 0.94); border: 1px solid #29465f; border-radius: 7px;
  box-shadow: 0 2px 10px rgba(0,0,0,.28); font: 11px/1.35 system-ui, sans-serif; }
.sp-voice button { min-height: 25px; padding: 3px 8px; color: #dbe7f2; background: #14283a;
  border: 1px solid #315574; border-radius: 5px; font: inherit; cursor: pointer; }
.sp-voice button:hover:not(:disabled) { background: #1b3a53; border-color: #4d83aa; }
.sp-voice button:focus-visible { outline: 2px solid #78bce8; outline-offset: 1px; }
.sp-voice button:disabled { cursor: default; color: #768a9b; border-color: #253746; background: #111d27; }
.sp-voice-main[data-live="true"] { color: #bcebd0; border-color: #37785b; background: #173629; }
.sp-voice-main[data-speaking="true"] { box-shadow: inset 0 0 0 1px #72db9d; }
.sp-voice-mic[aria-pressed="false"] { color: #f2b3ae; border-color: #7d4544; background: #3b2022; }
.sp-voice-hear { color: #ffe3a2 !important; border-color: #8a6c32 !important; }
.sp-voice-note { max-width: 210px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #90a8bb; }
`;

interface VoiceCredentials {
  serverUrl: string;
  participantToken: string;
  roomName: string;
}

type VoiceState = 'checking' | 'unavailable' | 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

/** Voice can contain several browser tabs for one account; the Users roster draws one aggregate state. */
export interface VoiceMemberState {
  userId: string;
  username: string;
  microphone: boolean;
  speaking: boolean;
  self: boolean;
  locallyMuted: boolean;
}

export interface VoiceChat {
  el: HTMLElement;
  members(): readonly VoiceMemberState[];
  toggleMemberMute(userId: string): void;
  subscribe(listener: () => void): () => void;
  probe(): Promise<void>;
  leave(): void;
}

interface VoiceAudioTrack {
  readonly kind: string;
  attach(): HTMLMediaElement;
  detach(): HTMLMediaElement[];
}

/**
 * Own the DOM elements that make subscribed LiveKit tracks audible. The host must be page-stable: the Voice
 * controls themselves live inside the Users panel, whose subtree is deliberately destroyed on every mode
 * switch. Removing a playing media element can silence it without disconnecting its WebRTC track.
 */
export function createVoiceAudioMount(host: Pick<HTMLElement, 'appendChild'>) {
  const attached = new Set<HTMLMediaElement>();
  return {
    attach(track: VoiceAudioTrack): void {
      if (track.kind !== 'audio') return;
      const media = track.attach();
      media.hidden = true;
      attached.add(media);
      host.appendChild(media);
    },
    detach(track: VoiceAudioTrack): void {
      if (track.kind !== 'audio') return;
      for (const media of track.detach()) {
        attached.delete(media);
        media.remove();
      }
    },
    clear(): void {
      for (const media of attached) media.remove();
      attached.clear();
    },
  };
}

export function createVoiceChat(deps: {
  /** Permanent page-level host; unlike `el`, it must not belong to a mode-specific panel. */
  audioHost: HTMLElement;
  notify?: (message: string, kind?: 'info' | 'warn' | 'err') => void;
}): VoiceChat {
  installStyles('voice-chat', CSS);

  const el = document.createElement('div');
  el.className = 'sp-voice';
  el.setAttribute('aria-label', 'Server voice chat');

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'sp-voice-main';
  const mic = document.createElement('button');
  mic.type = 'button';
  mic.className = 'sp-voice-mic';
  mic.textContent = 'Mic';
  mic.title = 'Mute microphone';
  const hear = document.createElement('button');
  hear.type = 'button';
  hear.className = 'sp-voice-hear';
  hear.textContent = 'Hear';
  hear.title = 'Allow voice audio playback';
  const leaveButton = document.createElement('button');
  leaveButton.type = 'button';
  leaveButton.textContent = 'Leave';
  leaveButton.title = 'Leave server voice chat';
  const note = document.createElement('span');
  note.className = 'sp-voice-note';
  el.append(main, mic, hear, leaveButton, note);

  let state: VoiceState = 'checking';
  let available = false;
  let wanted = false;
  let microphone = false;
  let room: LiveKitRoom | null = null;
  let generation = 0;
  let detail = '';
  let speakers = new Set<string>();
  // Local playback preference only: never sent to LiveKit or Slopesmith, and retained across a reconnect in
  // this browser tab. One account may own several LiveKit participants, so the key is the server user id.
  const locallyMutedUsers = new Set<string>();
  let memberSignature = '';
  const memberListeners = new Set<() => void>();
  const audio = createVoiceAudioMount(deps.audioHost);

  function participants(): Participant[] {
    if (!room) return [];
    return [room.localParticipant, ...room.remoteParticipants.values()];
  }

  function voiceMembers(): VoiceMemberState[] {
    const byUser = new Map<string, VoiceMemberState>();
    for (const participant of participants()) {
      const userId = participant.attributes['slopesmith.userId'];
      if (!userId) continue;
      const username = participant.attributes['slopesmith.username'] || participant.name || userId;
      const current = byUser.get(userId);
      const speaking = speakers.has(participant.identity);
      if (current) {
        current.microphone ||= participant.isMicrophoneEnabled;
        current.speaking ||= speaking;
        current.self ||= participant === room?.localParticipant;
      } else {
        byUser.set(userId, {
          userId,
          username,
          microphone: participant.isMicrophoneEnabled,
          speaking,
          self: participant === room?.localParticipant,
          locallyMuted: false,
        });
      }
    }
    const result = [...byUser.values()].sort((a, b) => a.userId.localeCompare(b.userId));
    for (const member of result) member.locallyMuted = !member.self && locallyMutedUsers.has(member.userId);
    return result;
  }

  function publishMemberState(): void {
    const signature = voiceMembers()
      .map(member => `${member.userId}:${member.username}:${Number(member.microphone)}:${Number(member.speaking)}`
        + `:${Number(member.self)}:${Number(member.locallyMuted)}`).join('|');
    if (signature === memberSignature) return;
    memberSignature = signature;
    for (const listener of memberListeners) listener();
  }

  function paint(): void {
    const connected = state === 'connected' || state === 'reconnecting';
    const count = participants().length;
    main.disabled = connected || state === 'checking' || state === 'unavailable' || state === 'connecting';
    main.dataset.live = String(connected);
    main.dataset.speaking = String(!!room && speakers.has(room.localParticipant.identity));
    main.textContent = state === 'checking' ? 'Voice…'
      : state === 'unavailable' ? 'Voice unavailable'
      : state === 'connecting' ? 'Joining voice…'
      : state === 'reconnecting' ? `Voice reconnecting · ${count}`
      : state === 'connected' ? `Voice · ${count}`
      : state === 'error' ? 'Retry voice'
      : 'Join voice';
    main.title = connected ? `${count} participant${count === 1 ? '' : 's'} in server voice; see the member list below.`
      : available ? 'Join this server\'s voice chat' : 'This server has not enabled voice chat';
    mic.hidden = !connected;
    mic.disabled = state === 'reconnecting';
    mic.setAttribute('aria-pressed', String(microphone));
    mic.textContent = microphone ? 'Mic on' : 'Muted';
    mic.title = microphone ? 'Mute microphone' : 'Unmute microphone';
    hear.hidden = !connected || !room || room.canPlaybackAudio;
    leaveButton.hidden = !connected;
    note.hidden = !detail || connected;
    note.textContent = detail;
    publishMemberState();
  }

  function clearAudio(): void {
    audio.clear();
  }

  function attachAudio(track: RemoteTrack): void {
    audio.attach(track);
  }

  function detachAudio(track: RemoteTrack): void {
    audio.detach(track);
  }

  const participantUserId = (participant: Participant): string =>
    participant.attributes['slopesmith.userId'] ?? '';

  /** SetVolume remembers the value for a microphone that has not arrived yet, covering late subscriptions. */
  function applyParticipantVolume(participant: RemoteParticipant): void {
    participant.setVolume(locallyMutedUsers.has(participantUserId(participant)) ? 0 : 1);
  }

  function applyParticipantVolumes(): void {
    if (!room) return;
    for (const participant of room.remoteParticipants.values()) applyParticipantVolume(participant);
  }

  function toggleMemberMute(userId: string): void {
    const ownId = room ? participantUserId(room.localParticipant) : '';
    if (!userId || userId === ownId) return;
    if (locallyMutedUsers.has(userId)) locallyMutedUsers.delete(userId);
    else locallyMutedUsers.add(userId);
    applyParticipantVolumes();
    paint();
  }

  function abandon(next?: LiveKitRoom): void {
    if (room && room !== next) void room.disconnect();
    if (!next) room = null;
    speakers.clear();
    clearAudio();
  }

  async function connect(): Promise<void> {
    if (!available) {
      detail = 'Voice is not configured here.';
      state = 'unavailable';
      paint();
      return;
    }
    wanted = true;
    const attempt = ++generation;
    const previousMic = microphone;
    state = 'connecting';
    detail = '';
    abandon();
    paint();
    try {
      const credentials = await postJson<VoiceCredentials>('/api/voice', '{}');
      const { Room, RoomEvent } = await import('livekit-client');
      if (attempt !== generation || !wanted) return;
      const joining = new Room({
        adaptiveStream: false,
        dynacast: false,
        audioCaptureDefaults: { autoGainControl: true, echoCancellation: true, noiseSuppression: true },
      });
      room = joining;
      joining
        .on(RoomEvent.TrackSubscribed,
          (track: RemoteTrack, _publication: RemoteTrackPublication, participant: RemoteParticipant) => {
            if (room !== joining) return;
            attachAudio(track);
            applyParticipantVolume(participant);
          })
        .on(RoomEvent.TrackUnsubscribed,
          (track: RemoteTrack, _publication: RemoteTrackPublication, _participant: RemoteParticipant) => {
            if (room !== joining) return;
            detachAudio(track);
          })
        .on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
          if (room !== joining) return;
          applyParticipantVolume(participant);
          paint();
        })
        .on(RoomEvent.ParticipantDisconnected, () => { if (room === joining) paint(); })
        .on(RoomEvent.ParticipantNameChanged, () => { if (room === joining) paint(); })
        .on(RoomEvent.ParticipantAttributesChanged, () => {
          if (room !== joining) return;
          applyParticipantVolumes();
          paint();
        })
        .on(RoomEvent.TrackPublished, () => { if (room === joining) paint(); })
        .on(RoomEvent.TrackUnpublished, () => { if (room === joining) paint(); })
        .on(RoomEvent.TrackMuted, () => { if (room === joining) paint(); })
        .on(RoomEvent.TrackUnmuted, () => { if (room === joining) paint(); })
        .on(RoomEvent.LocalTrackPublished, () => { if (room === joining) paint(); })
        .on(RoomEvent.LocalTrackUnpublished, () => { if (room === joining) paint(); })
        .on(RoomEvent.ActiveSpeakersChanged, (active: Participant[]) => {
          if (room !== joining) return;
          speakers = new Set(active.map(participant => participant.identity));
          paint();
        })
        .on(RoomEvent.AudioPlaybackStatusChanged, () => { if (room === joining) paint(); })
        .on(RoomEvent.Reconnecting, () => {
          if (room !== joining) return;
          state = 'reconnecting';
          paint();
        })
        .on(RoomEvent.Reconnected, () => {
          if (room !== joining) return;
          state = 'connected';
          paint();
        })
        .on(RoomEvent.Disconnected, () => {
          if (room !== joining) return;
          room = null;
          microphone = false;
          speakers.clear();
          clearAudio();
          state = wanted ? 'error' : 'idle';
          detail = wanted ? 'Voice connection ended.' : '';
          paint();
        });

      await joining.connect(credentials.serverUrl, credentials.participantToken, { autoSubscribe: true });
      if (attempt !== generation || !wanted) {
        void joining.disconnect();
        return;
      }
      state = 'connected';
      applyParticipantVolumes();
      paint();
      // The join button was a user gesture. Ask for playback and the microphone here; if the browser still
      // refuses one, the member remains connected listen-only and gets an explicit retry control.
      await joining.startAudio().catch(() => undefined);
      try {
        await joining.localParticipant.setMicrophoneEnabled(previousMic || !microphone);
        microphone = joining.localParticipant.isMicrophoneEnabled;
      } catch (error) {
        microphone = false;
        deps.notify?.(`Joined voice listen-only: ${error instanceof Error ? error.message : error}`, 'warn');
      }
      paint();
    } catch (error) {
      if (attempt !== generation) return;
      abandon();
      microphone = false;
      state = 'error';
      detail = error instanceof Error ? error.message : String(error);
      deps.notify?.(`Voice chat could not connect: ${detail}`, 'err');
      paint();
    }
  }

  async function toggleMicrophone(): Promise<void> {
    const active = room;
    if (!active || state !== 'connected') return;
    mic.disabled = true;
    try {
      await active.localParticipant.setMicrophoneEnabled(!microphone);
      if (room !== active) return;
      microphone = active.localParticipant.isMicrophoneEnabled;
    } catch (error) {
      deps.notify?.(`Microphone could not be ${microphone ? 'muted' : 'started'}: `
        + `${error instanceof Error ? error.message : error}`, 'err');
    }
    paint();
  }

  function leave(): void {
    wanted = false;
    generation++;
    microphone = false;
    abandon();
    state = available ? 'idle' : 'unavailable';
    detail = '';
    paint();
  }

  main.addEventListener('click', () => {
    if (state !== 'connected' && state !== 'reconnecting') void connect();
  });
  mic.addEventListener('click', () => { void toggleMicrophone(); });
  hear.addEventListener('click', () => {
    void room?.startAudio().then(() => paint())
      .catch(error => deps.notify?.(`Voice playback is still blocked: ${error}`, 'warn'));
  });
  leaveButton.addEventListener('click', leave);

  const api: VoiceChat = {
    el,
    members: voiceMembers,
    toggleMemberMute,
    subscribe(listener: () => void): () => void {
      memberListeners.add(listener);
      return () => memberListeners.delete(listener);
    },
    async probe(): Promise<void> {
      try {
        available = (await fetchJson<{ enabled: boolean }>('/api/voice')).enabled;
        state = available ? 'idle' : 'unavailable';
        detail = '';
      } catch {
        available = false;
        state = 'unavailable';
        detail = '';
      }
      paint();
    },
    leave,
  };
  paint();
  return api;
}
