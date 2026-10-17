// Runs one BLIT386 game in the terminal (or headless, for tests and snapshots).

import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { format } from 'node:util';
import { createCanvas } from '@napi-rs/canvas';
import { configureAssets, installAssets } from './env/assets.js';
import { unwrap } from './env/canvas.js';
import { installAudio } from './env/audio.js';
import { installDom } from './env/dom.js';
import { installGpu } from './env/gpu.js';
import { Input } from './term/input.js';
import { Screen } from './term/screen.js';

/** Walks up from the game file to the folder holding package.json. */
export function findProjectDir(gameFile) {
  let dir = dirname(resolve(gameFile));
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) return dirname(resolve(gameFile));
    dir = up;
  }
}

/** Sends console output to a log file: the terminal belongs to the game. */
function redirectConsole(logFile, echo) {
  mkdirSync(dirname(logFile), { recursive: true });
  const stream = createWriteStream(logFile, { flags: 'w' });
  const errors = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    console[level] = (...args) => {
      const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${format(...args)}\n`;
      stream.write(line);
      if (level === 'error') errors.push(format(...args));
      echo?.(level, line);
    };
  }
  return { stream, errors };
}

/** Fake terminal for headless runs: fixed size, collects everything written. */
class MemoryTerminal {
  chunks = [];

  constructor(cols, rows) {
    this.columns = cols;
    this.rows = rows;
    this.isTTY = false;
  }

  write(s) {
    this.chunks.push(s);
    return true;
  }

  on() {}

  off() {}

  once() {}

  get text() {
    return this.chunks.join('');
  }
}

/**
 * @param {object} o
 * @param {string} o.gameFile path to the game's entry module (src/game.js)
 * @param {'auto'|'webgpu'|'software'} [o.backend]
 * @param {string} [o.search] query string for the game (?seed=1)
 * @param {object} [o.screen] { colors, scale, zoom, isStatusVisible }
 * @param {object} [o.input] { layout, repeatDelayMs, repeatWindowMs, isMouseEnabled }
 * @param {number} [o.fps] terminal refresh rate
 * @param {string} [o.logFile]
 * @param {object} [o.headless] { frames, at, cols, rows, png, ansi, keys:[{frame, code, type}] } run without a TTY;
 *   `at` seeks the engine clock to that many seconds (BT.renderAt) and captures that frame
 * @param {string[]} [o.dawnOptions]
 * @param {boolean} [o.isDevMode] behave like the Vite dev server: no splash, BT.isDevMode true
 * @param {boolean} [o.isAudioEnabled] false: no AudioContext at all (the engine runs silent)
 * @param {boolean} [o.isMuted] audio runs but goes nowhere; default true when headless
 */
export async function run(o) {
  const gameFile = resolve(o.gameFile);
  const projectDir = o.projectDir ?? findProjectDir(gameFile);
  const logFile = o.logFile ?? join(process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? '.', '.local/state'), 'blit-term/last.log');
  const headless = o.headless ?? null;
  const log = redirectConsole(logFile, o.echoLog);
  console.log(`[blit-term] game ${gameFile}, project ${projectDir}`);

  configureAssets({ publicDir: join(projectDir, 'public'), rootDir: projectDir });
  installAssets();

  const backend = o.backend ?? 'auto';
  let gpuInfo = null;
  if (backend !== 'software') {
    gpuInfo = await installGpu({ unwrap, dawnOptions: o.dawnOptions ?? [] });
    if (!gpuInfo && backend === 'webgpu') throw new Error('WebGPU was requested (--backend webgpu) but no adapter is available. See the log: ' + logFile);
    if (gpuInfo) console.log(`[blit-term] WebGPU adapter: ${gpuInfo.description}`);
  }

  if (o.isAudioEnabled !== false) {
    const isMuted = o.isMuted ?? !!headless;
    if (await installAudio({ isMuted })) console.log(`[blit-term] Audio: node-web-audio-api${isMuted ? ' (muted)' : ''}`);
  }

  let search = o.search ?? '';
  if (backend === 'software' || (backend === 'auto' && !gpuInfo)) {
    // Ask the engine for its software renderer directly instead of letting it
    // fail to find WebGPU first (which logs three errors).
    const p = new URLSearchParams(search);
    p.set('backend', 'software');
    search = `?${p}`;
  }

  const term = headless ? new MemoryTerminal(headless.cols ?? 160, headless.rows ?? 60) : process.stdout;
  const screen = new Screen(term, {
    colors: o.screen?.colors ?? 'truecolor',
    scale: o.screen?.scale ?? 'average',
    zoom: o.screen?.zoom ?? 'auto',
    isStatusVisible: o.screen?.isStatusVisible ?? false,
  });

  const { canvas, clock, document } = installDom({
    search,
    gpu: gpuInfo?.gpu ?? null,
    viewport: () => ({ cols: screen.cols, rows: screen.rows }),
  });
  // Release build by default (splash shown, dev keys off); --dev matches `bun run dev`.
  globalThis.__BLIT386_DEV__ = o.isDevMode === true;

  // The game's own copy of the engine: same module instance the game imports.
  const enginePath = Bun.resolveSync('blit386', dirname(gameFile));
  const engine = await import(pathToFileURL(enginePath).href);
  const BT = engine.BT;

  let isQuitting = false;
  let input = null;
  const targets = [canvas, canvas.parentNode, document.body, document, globalThis];

  const cleanup = () => {
    input?.stop();
    screen.leave();
  };

  const quit = (code = 0, message = '') => {
    if (isQuitting) return;
    isQuitting = true;
    // Every step may fail when the terminal is already gone (closed window,
    // killed tmux session): writes then throw EIO. None of that may keep the
    // process alive, so each step is guarded and exit always runs.
    const attempt = (fn) => {
      try {
        fn();
      } catch {}
    };
    attempt(cleanup);
    attempt(() => log.stream.end());
    // stdout, not stderr: in interactive mode stderr is redirected to a file.
    if (message) attempt(() => process.stdout.write(`${message}\n`));
    if (log.errors.length && !headless) {
      attempt(() => process.stdout.write(`blit-term: the game logged ${log.errors.length} error(s). Last: ${log.errors.at(-1)}\nFull log: ${logFile}\n`));
    }
    process.exit(code);
  };

  if (!headless) {
    if (!process.stdout.isTTY || !process.stdin.isTTY) throw new Error('blit-term needs an interactive terminal (stdin and stdout must be a TTY).');
    screen.enter();
    input = new Input({ stdin: process.stdin, stdout: process.stdout, screen, targets, canvas, onQuit: () => quit(0), ...o.input });
    input.start();
    for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, () => quit(0));
    // The terminal went away without a signal reaching us: stop instead of
    // spinning on a dead TTY.
    for (const stream of [process.stdin, process.stdout]) {
      stream.on('error', () => quit(0));
      stream.on('close', () => quit(0));
    }
    process.stdin.on('end', () => quit(0));
    process.on('uncaughtException', (err) => quit(1, `blit-term crashed: ${err?.stack ?? err}`));
    process.on('unhandledRejection', (err) => console.error('[blit-term] Unhandled rejection:', err));
  }

  await import(pathToFileURL(gameFile).href);

  // Frame loop: run rAF callbacks, then pull the finished frame to the terminal.
  const fps = o.fps ?? 60;
  const interval = 1000 / fps;
  let frame = 0;
  let isReading = false;
  let shownFrames = 0;
  let fpsWindowStart = performance.now();
  let shownFps = 0;
  let lastFrame = null;
  // Smoothed per-frame cost of each stage, shown in the status line.
  const timing = { engine: 0, read: 0, draw: 0 };
  const ema = (avg, v) => avg * 0.9 + v * 0.1;

  return new Promise((resolveRun, rejectRun) => {
    let next = performance.now();
    const tick = async () => {
      if (isQuitting) return;
      const now = performance.now();
      clock.run(now);
      timing.engine = ema(timing.engine, performance.now() - now);
      frame++;
      for (const k of headless?.keys ?? []) {
        if (k.frame === frame) {
          for (const t of targets) t.dispatchEvent(new KeyboardEvent(k.type ?? 'keydown', { code: k.code, key: k.key ?? k.code }));
        }
      }
      const isReady = BT.activeBackend != null;
      if (isReady && !isReading && !screen.isBusy) {
        isReading = true;
        try {
          const t0 = performance.now();
          const f = await canvas.readFrame();
          const t1 = performance.now();
          timing.read = ema(timing.read, t1 - t0);
          if (f) {
            lastFrame = f;
            const ds = BT.displaySize;
            screen.statusText = `${BT.activeBackend}${gpuInfo && BT.activeBackend === 'webgpu' ? ` (${gpuInfo.description})` : ''} | ${ds.x}x${ds.y} -> ${screen.layout?.width ?? '?'}x${screen.layout?.height ?? '?'} px | ${shownFps} fps | engine ${timing.engine.toFixed(1)} read ${timing.read.toFixed(1)} draw ${timing.draw.toFixed(1)} ms | keys: ${input?.mode ?? 'headless'} | Ctrl+C quits`;
            screen.draw(f, { x: ds.x, y: ds.y });
            timing.draw = ema(timing.draw, performance.now() - t1);
            shownFrames++;
          }
        } catch (err) {
          console.error('[blit-term] Frame capture failed:', err);
        } finally {
          isReading = false;
        }
      }
      if (now - fpsWindowStart >= 1000) {
        shownFps = shownFrames;
        shownFrames = 0;
        fpsWindowStart = now;
      }

      // Deterministic snapshot: once the engine is up, seek its clock like the
      // demos' /shots page does (BT.renderAt), then grab that exact frame.
      if (headless?.at !== undefined && BT.isReady === true && !headless.isSeekDone) {
        headless.isSeekDone = true;
        try {
          await BT.renderAt(headless.at);
          const f = await waitForFrame(canvas);
          if (f) {
            lastFrame = f;
            screen.draw(f, { x: BT.displaySize.x, y: BT.displaySize.y });
          }
        } catch (err) {
          console.error('[blit-term] renderAt failed:', err);
        }
        headless.frames = frame;
      }

      const isSeekPending = headless?.at !== undefined && !headless.isSeekDone && frame < 60 * 30;
      if (headless && frame >= (headless.frames ?? 120) && !isSeekPending) {
        try {
          if (headless.png && lastFrame) writePng(headless.png, lastFrame);
          if (headless.ansi) writeFileSync(headless.ansi, term.text);
          resolveRun({ frames: frame, backend: BT.activeBackend, displaySize: BT.displaySize, errors: log.errors, logFile, lastFrame, ansi: term.text });
        } catch (err) {
          rejectRun(err);
        }
        log.stream.end();
        return;
      }
      next += interval;
      const delay = next - performance.now();
      if (delay < -interval * 4) next = performance.now(); // fell far behind: don't sprint to catch up
      setTimeout(tick, Math.max(0, delay));
    };
    setTimeout(tick, 0);
  });
}

async function waitForFrame(canvas) {
  for (let i = 0; i < 10; i++) {
    const f = await canvas.readFrame();
    if (f) return f;
    await new Promise((r) => setTimeout(r, 5));
  }
  return null;
}

function writePng(file, f) {
  const c = createCanvas(f.width, f.height);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(f.width, f.height);
  img.data.set(f.data);
  ctx.putImageData(img, 0, 0);
  writeFileSync(file, c.toBuffer('image/png'));
}
