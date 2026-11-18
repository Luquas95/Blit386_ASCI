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

Already have Bun and a BLIT386 game? Inside the game's folder:

```bash
bun add -d github:Luquas95/Blit386_ASCI   # once per game
bunx blit-term                            # play src/game.js in this terminal
```

Quit with `Ctrl+C`. The full steps, from a fresh machine, are below.

## Installation

### 1. Requirements

- **Linux or macOS.** Windows is not supported natively.
- **A terminal with truecolor** (24-bit color), which most current terminals have: Kitty, WezTerm, Ghostty, foot,
  iTerm2, GNOME Terminal, Konsole and others. Kitty, WezTerm, Ghostty and foot are best, because they report key releases (see
  [What differs](#what-is-the-same-as-in-the-browser)). Older terminals work with `--colors 256`.
- **Bun 1.3 or newer.**

### 2. Install Bun

```bash
# Debian / Ubuntu only: the installer needs unzip
sudo apt install unzip

curl -fsSL https://bun.sh/install | bash
```

Open a new terminal (or run `source ~/.bashrc`) and check it with `bun --version`.

If a terminal still says `bun: command not found`, it is probably a login shell that reads `~/.profile` instead of
`~/.bashrc` (some web and remote terminals do this). Add Bun to `~/.profile` as well:

```bash
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.profile
```

### 3. Optional system libraries

Both are optional: without them the game still runs, `blit-term` falls back automatically.

| For | Linux package (Debian / Ubuntu) | Without it |
| --- | --- | --- |
| Sound | `libasound2t64` (older releases: `libasound2`) | the game runs silent |
| GPU rendering (WebGPU through Dawn) | a Vulkan driver, e.g. `mesa-vulkan-drivers` | the engine's software renderer is used |

macOS needs nothing extra: sound uses Core Audio and WebGPU uses Metal.

### 4. Install `blit-term`

**In a game project (recommended).** The game then pins the version it was tested with, and anyone who clones it gets
`blit-term` with a plain `bun install`.

```bash
cd my-blit386-game
bun add -d github:Luquas95/Blit386_ASCI
```

Add a script to the game's `package.json` so it starts with `bun run term`:

```json
{ "scripts": { "term": "blit-term" } }
```

**Or once for all games**, as a global command:

```bash
bun add -g github:Luquas95/Blit386_ASCI
```

A global `blit-term` still uses each game's own copy of the engine, so the game's dependencies must be installed
(`bun install` in its folder).

### 5. Play

```bash
cd my-blit386-game
bun install          # the game's dependencies, once
bun run term         # or: bunx blit-term, or: blit-term (global install)
```

Run it **inside the game's folder**: `blit-term` looks for `src/game.js` (or `src/game.ts`, `src/main.js`,
`src/main.ts`) there. Another entry file can be given as an argument: `blit-term path/to/game.js`.

**Make the terminal big enough for a sharp picture.** One character cell shows 1x2 game pixels, so a game of W x H
pixels needs **W columns and H / 2 rows** (one more row with `--status`). A 320x240 game needs 320x120, a 128x80 game
128x40. Check your terminal with `stty size` (prints rows, then columns). A smaller terminal gets a shrunk, blurrier
picture; make the window bigger or the font smaller. `--status` shows the size in use.

### Updating and removing

```bash
bun update blit386-term                     # in a game project
bun add -g github:Luquas95/Blit386_ASCI     # global: installs the latest version again

bun remove blit386-term                     # from a game project
bun remove -g blit386-term                  # global
```

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `bun: command not found` | See [Install Bun](#2-install-bun): open a new terminal, or add Bun to `~/.profile`. |
| `error: Script not found "term"` | Run it in the game's folder, and check that `package.json` has the `term` script. |
| The picture is blurry | The terminal is smaller than the game; see the size rule in [Play](#5-play). `--scale nearest` keeps it sharp but drops pixels. |
| No sound | Install the sound library from [step 3](#3-optional-system-libraries). The engine also waits for the first key press before it plays anything, as in a browser. |
| Keys stick or repeat | Your terminal has no key-release reports (tmux and most older terminals). Use Kitty, WezTerm, Ghostty or foot, or tune `--repeat-delay` to your keyboard's autorepeat delay. |
| `Ctrl+C` does not quit | Some web terminals keep `Ctrl+C` for themselves. Close the tab, or run `pkill -f blit-term` from another terminal. |
| Anything else | Read the logs: `~/.local/state/blit-term/last.log` (the game's console) and `last.stderr.log` (native libraries). |

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
- **localStorage** is saved to a JSON file per game in `~/.local/state/blit-term/storage/` (named after the game's
  folder), so saves and settings survive between runs as in the browser. `sessionStorage` lasts until the game closes.
  Headless runs keep localStorage in memory unless `--storage <dir>` is given; `--no-storage` turns saving off.

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
| `--storage <dir>`, `--no-storage` | state folder | where localStorage is saved, or keep it in memory only |

## Development

```bash
bun install
bun test                                    # unit tests
bun test/compare-shots.js --demos <dir>     # pixel comparison against the demos' reference shots
bun bin/blit-term.js --headless --png out.png path/to/game.js
```

## License

ISC
