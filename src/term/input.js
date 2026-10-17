// Feeds terminal input into the engine as browser events.
//
// Keys: with the kitty keyboard protocol the terminal reports real press,
// repeat and release. Without it (most terminals, tmux) only presses arrive,
// so a release is guessed: a key counts as held until `repeatDelayMs` passes
// without an autorepeat, then `repeatWindowMs` after the last autorepeat.
// As soon as one real release event is seen, guessing stops for good.
//
// Mouse: SGR reports become PointerEvents in canvas pixel coordinates.

import { KeyParser } from './keys.js';
import { KeyboardEvent, PointerEvent, WheelEvent, FocusEvent } from '../env/events.js';

const MOD_KEYS = [
  ['shift', 'ShiftLeft', 'Shift'],
  ['ctrl', 'ControlLeft', 'Control'],
  ['alt', 'AltLeft', 'Alt'],
];

const KITTY_FLAGS = 1 | 2 | 4 | 8; // disambiguate, event types, alternate keys, all keys as escapes

export class Input {
  #parser;
  #held = new Map(); // code -> { timer, key }
  #escTimer = null;
  #isKittyPushed = false;
  #isReleaseSeen = false;
  #buttons = 0;
  #lastPointer = { x: 0, y: 0 };

  /**
   * @param {object} o
   * @param {NodeJS.ReadStream} o.stdin
   * @param {NodeJS.WriteStream} o.stdout
   * @param {import('./screen.js').Screen} o.screen
   * @param {EventTarget[]} o.targets bubbling path for keyboard events (canvas first)
   * @param {EventTarget} o.canvas pointer events go here
   * @param {() => void} o.onQuit
   */
  constructor({ stdin, stdout, screen, targets, canvas, onQuit, layout = 'us', repeatDelayMs = 500, repeatWindowMs = 100, isMouseEnabled = true }) {
    this.stdin = stdin;
    this.stdout = stdout;
    this.screen = screen;
    this.targets = targets;
    this.canvas = canvas;
    this.onQuit = onQuit;
    this.repeatDelayMs = repeatDelayMs;
    this.repeatWindowMs = repeatWindowMs;
    this.isMouseEnabled = isMouseEnabled;
    this.#parser = new KeyParser({ layout });
  }

  get mode() {
    return this.#isReleaseSeen ? 'kitty' : this.#isKittyPushed ? 'kitty?' : 'legacy';
  }

  start() {
    if (this.stdin.isTTY) this.stdin.setRawMode(true);
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', this.#onData);
    this.stdin.resume();
    let seq = '\x1b[?1004h'; // focus in/out reports
    if (this.isMouseEnabled) seq += '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h';
    seq += '\x1b[?u\x1b[c'; // ask for kitty keyboard support, then a DA1 fence
    this.stdout.write(seq);
  }

  stop() {
    this.stdin.off('data', this.#onData);
    clearTimeout(this.#escTimer);
    for (const h of this.#held.values()) clearTimeout(h.timer);
    this.#held.clear();
    let seq = '';
    if (this.#isKittyPushed) seq += '\x1b[<u';
    if (this.isMouseEnabled) seq += '\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l';
    seq += '\x1b[?1004l';
    this.stdout.write(seq);
    if (this.stdin.isTTY) this.stdin.setRawMode(false);
    this.stdin.pause();
  }

  #onData = (chunk) => {
    clearTimeout(this.#escTimer);
    for (const t of this.#parser.feed(chunk)) this.#handle(t);
    if (this.#parser.hasPendingEscape) {
      this.#escTimer = setTimeout(() => {
        for (const t of this.#parser.flush()) this.#handle(t);
      }, 25);
    }
  };

  #handle(t) {
    if (t.type === 'key') return this.#handleKey(t);
    if (t.type === 'mouse') return this.#handleMouse(t);
    if (t.type === 'kitty-flags' && !this.#isKittyPushed) {
      this.#isKittyPushed = true;
      this.stdout.write(`\x1b[>${KITTY_FLAGS}u`);
      return;
    }
    if (t.type === 'focus' && !t.isFocused) this.releaseAll();
  }

  #handleKey(t) {
    if (t.code === 'KeyC' && t.mods.ctrl && t.kind !== 'release') {
      this.onQuit();
      return;
    }
    if (t.kind === 'release') {
      if (!this.#isReleaseSeen) {
        this.#isReleaseSeen = true;
        // Real releases from now on: stop guessing, keep currently held keys down.
        for (const h of this.#held.values()) clearTimeout(h.timer);
      }
      this.#up(t.code, t.key, t.mods);
      return;
    }
    if (!t.code) return;
    const h = this.#held.get(t.code);
    if (h) {
      this.#emit('keydown', t.code, t.key, t.mods, true);
      this.#scheduleRelease(t.code, this.repeatWindowMs);
      return;
    }
    if (!this.#isReleaseSeen) {
      // Legacy terminals report modifiers only as flags on the key itself.
      for (const [flag, code, key] of MOD_KEYS) {
        if (t.mods[flag] && !this.#held.has(code) && code !== t.code) {
          this.#held.set(code, { key, timer: null, mods: t.mods });
          this.#emit('keydown', code, key, t.mods, false);
          this.#scheduleRelease(code, this.repeatDelayMs);
        }
      }
    }
    this.#held.set(t.code, { key: t.key, timer: null, mods: t.mods });
    this.#emit('keydown', t.code, t.key, t.mods, t.kind === 'repeat');
    this.#scheduleRelease(t.code, this.repeatDelayMs);
  }

  #scheduleRelease(code, ms) {
    if (this.#isReleaseSeen) return;
    const h = this.#held.get(code);
    if (!h) return;
    clearTimeout(h.timer);
    h.timer = setTimeout(() => this.#up(code, h.key, h.mods), ms);
    // Modifiers emulated alongside a key live as long as that key.
    for (const [flag, mcode] of MOD_KEYS) {
      const m = this.#held.get(mcode);
      if (m && mcode !== code && h.mods?.[flag]) {
        clearTimeout(m.timer);
        m.timer = setTimeout(() => this.#up(mcode, m.key, m.mods), ms + 5);
      }
    }
  }

  #up(code, key, mods) {
    const h = this.#held.get(code);
    if (h) clearTimeout(h.timer);
    this.#held.delete(code);
    this.#emit('keyup', code, h?.key ?? key, mods ?? {}, false);
  }

  releaseAll() {
    for (const [code, h] of [...this.#held]) this.#up(code, h.key, h.mods);
    if (this.#buttons) {
      this.#pointer('pointerup', this.#lastPointer, 0, 0, {});
      this.#buttons = 0;
    }
    for (const target of this.targets) target.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
  }

  #emit(type, code, key, mods, repeat) {
    const init = {
      code,
      key,
      repeat,
      shiftKey: !!mods.shift,
      ctrlKey: !!mods.ctrl,
      altKey: !!mods.alt,
      metaKey: !!mods.meta,
      location: code.endsWith('Right') ? 2 : code.endsWith('Left') && /Shift|Control|Alt|Meta/.test(code) ? 1 : code.startsWith('Numpad') ? 3 : 0,
    };
    // Bubble by hand: canvas -> container -> body -> document -> window.
    for (const target of this.targets) {
      const ev = new KeyboardEvent(type, init);
      target.dispatchEvent(ev);
      if (ev.cancelBubble) break;
    }
  }

  #handleMouse(t) {
    const p = this.screen.cellToCanvas(t.x, t.y);
    if (!p) return;
    this.#lastPointer = p;
    const mods = t.mods;
    if (t.kind === 'wheel') {
      this.canvas.dispatchEvent(
        new WheelEvent('wheel', { clientX: p.x, clientY: p.y, deltaX: t.deltaX * 3, deltaY: t.deltaY * 3, deltaMode: 1, shiftKey: mods.shift, ctrlKey: mods.ctrl, altKey: mods.alt }),
      );
      return;
    }
    const bit = t.button === 0 ? 1 : t.button === 1 ? 4 : t.button === 2 ? 2 : 0;
    if (t.kind === 'down') {
      this.#buttons |= bit;
      this.#pointer('pointerdown', p, t.button, this.#buttons, mods);
    } else if (t.kind === 'up') {
      // SGR releases carry the button; some terminals report 3 ("any").
      this.#buttons &= bit ? ~bit : 0;
      this.#pointer('pointerup', p, t.button < 0 ? 0 : t.button, this.#buttons, mods);
    } else {
      this.#pointer('pointermove', p, -1, this.#buttons, mods);
    }
  }

  #pointer(type, p, button, buttons, mods) {
    this.canvas.dispatchEvent(
      new PointerEvent(type, {
        clientX: p.x,
        clientY: p.y,
        button,
        buttons,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        shiftKey: !!mods.shift,
        ctrlKey: !!mods.ctrl,
        altKey: !!mods.alt,
      }),
    );
  }
}
