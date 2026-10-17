// Web Audio for Bun via node-web-audio-api (Rust, plays through the system's
// default output: PipeWire, PulseAudio or ALSA). The engine's own unlock rule
// still applies: sound starts after the first key press or click.

/**
 * @param {{isMuted?: boolean}} [opts] isMuted: real audio graph, no output device
 *   (headless runs and --mute); the game behaves the same, nothing is heard.
 */
export async function installAudio({ isMuted = false } = {}) {
  let mod;
  try {
    mod = await import('node-web-audio-api');
  } catch (err) {
    console.warn(`[blit-term] Audio disabled, node-web-audio-api failed to load: ${err?.message ?? err}`);
    return false;
  }
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value === 'function' && /^[A-Z]/.test(name) && !(name in globalThis)) {
      Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
    }
  }
  if (isMuted) {
    const Base = mod.AudioContext;
    globalThis.AudioContext = class MutedAudioContext extends Base {
      constructor(options = {}) {
        super({ ...options, sinkId: { type: 'none' } });
      }
    };
  }
  globalThis.webkitAudioContext = globalThis.AudioContext;
  return true;
}
