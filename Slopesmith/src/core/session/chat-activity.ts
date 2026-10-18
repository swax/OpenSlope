import type { PlayServerMessage } from './play-protocol.generated';

/** Counts come from the Rust site-presence contract. */
export type ChatActivity = Pick<Extract<PlayServerMessage, { t: 'site-presence' }>, 'online' | 'courses'>;
