export interface VideoBridgePrefs {
  /** Local Jukebox playback. Yattee supplies VideoTexture surfaces; YouTube is the DOM fallback. */
  enabled: boolean;
  /** Yattee's HTTP(S) origin. The browser talks to it directly; Slopesmith's server never sees the request. */
  serverUrl: string;
  /** HTTP Basic Auth credentials owned by this Yattee installation. */
  username: string;
  password: string;
}
