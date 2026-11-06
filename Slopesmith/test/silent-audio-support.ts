/** Device boundary for scene-state tests. Actual audio decoding and playback stay in browser checks. */
export function installSilentAudio() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  class SilentAudioContext {
    state = 'running';
    currentTime = 0;
    destination = {};
    createGain() {
      return { gain: { value: 1 }, connect() {}, disconnect() {} };
    }
  }
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: SilentAudioContext });
  return () => {
    if (previous) Object.defineProperty(globalThis, 'AudioContext', previous);
    else Reflect.deleteProperty(globalThis, 'AudioContext');
  };
}
