#!/usr/bin/env bun
// blit-term: run an unmodified BLIT386 game in the terminal.

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { run } from '../src/run.js';

const HELP = `Usage: blit-term [options] [game-entry]

Runs a BLIT386 game in this terminal. game-entry defaults to src/game.js
(or src/game.ts) in the current folder. The game is not modified: the real
engine runs inside Bun and blit-term stands in for the browser.

Display
  --backend <b>        auto (default) | webgpu | software
                       auto tries WebGPU through Dawn and falls back to software.
  --colors <c>         truecolor (default) | 256
  --scale <s>          average (default) | nearest   how to shrink when the
                       terminal is smaller than the game
  --zoom <z>           auto (default, largest whole zoom that fits) or a number
  --fps <n>            terminal refresh rate, default 60
  --status             show a status line (backend, size, fps, key mode)

Input
  --layout <l>         us (default) | cz | cz-qwertz   keyboard layout used to
                       map typed characters when the terminal has no kitty
                       keyboard protocol
  --repeat-delay <ms>  legacy terminals: how long a key counts as held after a
                       single press, default 500 (match your autorepeat delay)
  --repeat-window <ms> legacy terminals: release after the last autorepeat, default 100
  --no-mouse           do not capture the mouse

Sound
  --mute               run the audio engine but send it nowhere
  --no-audio           no audio at all (the game sees no AudioContext)

Game
  --dev                run as a development build, like \`bun run dev\`: no splash,
                       BT.isDevMode is true (debug HUDs, cheat keys)
  --seed <n>           pass ?seed=<n> to the game (repeatable runs)
  --query <q>          extra query string, e.g. "level=3&debug=1"
  --log <file>         log file, default ~/.local/state/blit-term/last.log

Headless (no terminal, for tests and snapshots)
  --headless           run without a TTY
  --frames <n>         frames to run, default 120
  --at <seconds>       instead of running N frames: seek the engine clock with
                       BT.renderAt(seconds) and capture that exact frame
  --size <cols>x<rows> virtual terminal size, default 160x60
  --png <file>         save the last canvas frame as PNG
  --ansi <file>        save the terminal output (ANSI) to a file

  -h, --help           show this text

Quit with Ctrl+C.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    backend: { type: 'string', default: 'auto' },
    colors: { type: 'string', default: 'truecolor' },
    scale: { type: 'string', default: 'average' },
    zoom: { type: 'string', default: 'auto' },
    fps: { type: 'string', default: '60' },
    status: { type: 'boolean', default: false },
    layout: { type: 'string', default: 'us' },
    'repeat-delay': { type: 'string', default: '500' },
    'repeat-window': { type: 'string', default: '100' },
    'no-mouse': { type: 'boolean', default: false },
    mute: { type: 'boolean', default: false },
    'no-audio': { type: 'boolean', default: false },
    dev: { type: 'boolean', default: false },
    seed: { type: 'string' },
    query: { type: 'string' },
    log: { type: 'string' },
    headless: { type: 'boolean', default: false },
    frames: { type: 'string', default: '120' },
    at: { type: 'string' },
    size: { type: 'string', default: '160x60' },
    png: { type: 'string' },
    ansi: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

function fail(msg) {
  process.stderr.write(`blit-term: ${msg}\nRun blit-term --help for usage.\n`);
  process.exit(2);
}

function oneOf(name, value, allowed) {
  if (!allowed.includes(value)) fail(`--${name} must be one of: ${allowed.join(', ')} (got "${value}")`);
  return value;
}

function positiveNumber(name, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) fail(`--${name} must be a positive number (got "${value}")`);
  return n;
}

if (values.help) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}

let gameFile = positionals[0];
if (!gameFile) {
  gameFile = ['src/game.js', 'src/game.ts', 'src/main.js', 'src/main.ts'].find((f) => existsSync(f));
  if (!gameFile) fail('no game entry given and none of src/game.js, src/game.ts, src/main.js, src/main.ts exists here');
}
if (!existsSync(gameFile)) fail(`game entry not found: ${gameFile}`);

const params = new URLSearchParams(values.query ?? '');
if (values.seed !== undefined) params.set('seed', values.seed);
const search = params.size ? `?${params}` : '';

const [cols, rows] = values.size.split('x').map(Number);
if (!(cols > 0 && rows > 0)) fail(`--size must look like 160x60 (got "${values.size}")`);

const defaultLog = join(process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? '.', '.local/state'), 'blit-term/last.log');
const logFile = values.log ? resolve(values.log) : defaultLog;

// Native code (Dawn, Mesa, audio backends) writes straight to stderr, which
// would scribble over the picture. In interactive mode we run ourselves again
// as a child whose stderr goes to a file; stdin/stdout stay on the terminal.
if (!values.headless && !process.env.BLIT_TERM_CHILD) {
  const stderrFile = logFile.replace(/\.log$/, '') + '.stderr.log';
  mkdirSync(dirname(stderrFile), { recursive: true });
  const child = Bun.spawn([process.execPath, import.meta.path, ...process.argv.slice(2)], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: Bun.file(stderrFile),
    env: { ...process.env, BLIT_TERM_CHILD: '1' },
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      child.kill(sig);
      // A child that cannot shut down cleanly must not outlive us.
      setTimeout(() => child.kill('SIGKILL'), 1500).unref();
    });
  }
  const code = await child.exited;
  if (code !== 0 && existsSync(stderrFile) && statSync(stderrFile).size > 0) {
    process.stderr.write(`blit-term: native output was saved to ${stderrFile}\n`);
  }
  process.exit(code);
}

const options = {
  gameFile: resolve(gameFile),
  backend: oneOf('backend', values.backend, ['auto', 'webgpu', 'software']),
  search,
  fps: positiveNumber('fps', values.fps),
  logFile,
  isDevMode: values.dev,
  isAudioEnabled: !values['no-audio'],
  isMuted: values.mute || values.headless,
  screen: {
    colors: oneOf('colors', values.colors, ['truecolor', '256']),
    scale: oneOf('scale', values.scale, ['average', 'nearest']),
    zoom: values.zoom === 'auto' ? 'auto' : positiveNumber('zoom', values.zoom),
    isStatusVisible: values.status,
  },
  input: {
    layout: oneOf('layout', values.layout, ['us', 'cz', 'cz-qwertz']),
    repeatDelayMs: positiveNumber('repeat-delay', values['repeat-delay']),
    repeatWindowMs: positiveNumber('repeat-window', values['repeat-window']),
    isMouseEnabled: !values['no-mouse'],
  },
  headless: values.headless
    ? { frames: positiveNumber('frames', values.frames), at: values.at === undefined ? undefined : Number(values.at), cols, rows, png: values.png && resolve(values.png), ansi: values.ansi && resolve(values.ansi) }
    : null,
};

try {
  const result = await run(options);
  if (result) {
    const ds = result.displaySize;
    process.stdout.write(
      `${JSON.stringify({ frames: result.frames, backend: result.backend, displaySize: ds ? [ds.x, ds.y] : null, frame: result.lastFrame ? [result.lastFrame.width, result.lastFrame.height] : null, errors: result.errors.length, log: result.logFile })}\n`,
    );
    process.exit(result.errors.length ? 1 : 0);
  }
} catch (err) {
  process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l');
  process.stdout.write(`blit-term: ${err?.message ?? err}\n`);
  process.exit(1);
}
