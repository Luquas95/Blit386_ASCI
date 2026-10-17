# Blit386_ASCI (`blit-term`)

Run unmodified [BLIT386](https://blit386.dev) games in a terminal.

The real engine runs inside [Bun](https://bun.sh); `blit-term` stands in for the browser. Frames are drawn with colored
half blocks (`▀`, two game pixels per character cell), keyboard and mouse come from the terminal, sound plays through
the system's audio output. The same `src/game.js` keeps working in the browser.

```text
game.js ──import 'blit386'──▶ the real engine (from the game's node_modules)
                                   │ browser APIs
                                   ▼
             ┌──────────────── blit-term ────────────────┐
             │ DOM shim     window, document, rAF, ...    │
             │ canvas       WebGPU (Dawn) or Canvas 2D    │
             │ assets       fetch / Image -> public/      │
             │ audio        Web Audio (node-web-audio-api)│
             │ screen       RGBA -> truecolor half blocks │
             │ input        keys (kitty / legacy), mouse  │
             └───────────────────────────────────────────┘
```

## Quick start

Requirements: Bun 1.3+, Linux or macOS, a terminal with truecolor (or use `--colors 256`).

```bash
# inside a BLIT386 game project
bun add -d github:Luquas95/Blit386_ASCI
bunx blit-term                 # runs src/game.js
bunx blit-term --status        # with a status line (backend, size, fps, key mode)
```

Or add a script to the game's `package.json`:

```json
{ "scripts": { "term": "blit-term --status" } }
```

Quit with `Ctrl+C`.

## What is the same as in the browser

Everything the engine draws, including palette effects (cycle, fade, swap, flash, exposure), sprites, bitmap fonts,
camera, tilemaps and, on the WebGPU backend, fullscreen post-process effects such as CRT. The test suite compares
`blit-term` frames with the reference screenshots the BLIT386 demos ship (captured in Chrome); most demos match pixel
for pixel. See the [wiki](https://github.com/Luquas95/Blit386_ASCI/wiki) for the full report.

What differs:

- **Resolution** depends on the terminal: one cell shows 1x2 pixels, so a 320x240 game needs 320x120 cells for 1:1.
  Smaller terminals get a proportionally shrunk picture (`--scale average` by default).
- **Keys in legacy terminals** (anything without the kitty keyboard protocol, including tmux) report presses only;
  releases are estimated from autorepeat. Kitty, WezTerm, Ghostty and foot report real releases.
- **Gamepads and touch** are not available.

## Options

Run `blit-term --help` for the full list. The important ones:

| Option | Default | Meaning |
| --- | --- | --- |
| `--backend auto\|webgpu\|software` | `auto` | WebGPU through Dawn, falling back to the engine's software renderer |
| `--colors truecolor\|256` | `truecolor` | color output |
| `--scale average\|nearest` | `average` | how to shrink when the terminal is too small |
| `--zoom auto\|<n>` | `auto` | whole-number zoom that fits, or a fixed zoom |
| `--layout us\|cz\|cz-qwertz` | `us` | keyboard layout for legacy terminals |
| `--repeat-delay <ms>` | `500` | legacy terminals: how long a single press holds a key |
| `--dev` | off | behave like `bun run dev` (no splash, `BT.isDevMode`) |
| `--seed <n>` | | pass `?seed=<n>` to the game |
| `--mute`, `--no-audio` | | silence the output, or remove audio entirely |

## Development

```bash
bun install
bun test                                    # unit tests
bun test/compare-shots.js --demos <dir>     # pixel comparison against the demos' reference shots
bun bin/blit-term.js --headless --png out.png path/to/game.js
```

Logs: `~/.local/state/blit-term/last.log` (engine console) and `last.stderr.log` (native libraries).

## License

ISC
