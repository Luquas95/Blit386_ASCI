// Terminal input parser. Turns raw stdin text into key and mouse tokens.
// Understands the kitty keyboard protocol (CSI ... u with press/repeat/release),
// classic xterm sequences, SGR mouse reports and a few terminal replies.
// Pure: no timers, no I/O. The caller flushes a lone ESC after a short pause.

/** Kitty keycodes (unicode or private-use) -> KeyboardEvent.code */
const KITTY_FUNCTIONAL = {
  9: 'Tab',
  13: 'Enter',
  27: 'Escape',
  32: 'Space',
  127: 'Backspace',
  57358: 'CapsLock',
  57359: 'ScrollLock',
  57360: 'NumLock',
  57361: 'PrintScreen',
  57362: 'Pause',
  57363: 'ContextMenu',
  57399: 'Numpad0',
  57400: 'Numpad1',
  57401: 'Numpad2',
  57402: 'Numpad3',
  57403: 'Numpad4',
  57404: 'Numpad5',
  57405: 'Numpad6',
  57406: 'Numpad7',
  57407: 'Numpad8',
  57408: 'Numpad9',
  57409: 'NumpadDecimal',
  57410: 'NumpadDivide',
  57411: 'NumpadMultiply',
  57412: 'NumpadSubtract',
  57413: 'NumpadAdd',
  57414: 'NumpadEnter',
  57415: 'NumpadEqual',
  57417: 'Numpad4',
  57418: 'Numpad6',
  57419: 'Numpad8',
  57420: 'Numpad2',
  57421: 'Numpad9',
  57422: 'Numpad3',
  57423: 'Numpad7',
  57424: 'Numpad1',
  57425: 'Numpad0',
  57426: 'NumpadDecimal',
  57427: 'Numpad5',
  57441: 'ShiftLeft',
  57442: 'ControlLeft',
  57443: 'AltLeft',
  57444: 'MetaLeft',
  57445: 'MetaLeft',
  57446: 'MetaLeft',
  57447: 'ShiftRight',
  57448: 'ControlRight',
  57449: 'AltRight',
  57450: 'MetaRight',
  57451: 'MetaRight',
  57452: 'MetaRight',
};

for (let i = 0; i < 23; i++) KITTY_FUNCTIONAL[57376 + i] = `F${13 + i}`;

/** CSI <n> ~ */
const TILDE = {
  2: 'Insert',
  3: 'Delete',
  5: 'PageUp',
  6: 'PageDown',
  7: 'Home',
  8: 'End',
  11: 'F1',
  12: 'F2',
  13: 'F3',
  14: 'F4',
  15: 'F5',
  17: 'F6',
  18: 'F7',
  19: 'F8',
  20: 'F9',
  21: 'F10',
  23: 'F11',
  24: 'F12',
  57427: 'Numpad5',
};

/** CSI [1;mods] <letter> and SS3 <letter> */
const LETTER = {
  A: 'ArrowUp',
  B: 'ArrowDown',
  C: 'ArrowRight',
  D: 'ArrowLeft',
  E: 'Numpad5',
  F: 'End',
  H: 'Home',
  P: 'F1',
  Q: 'F2',
  R: 'F3',
  S: 'F4',
};

/** US layout punctuation: char -> [code, isShifted] */
const US_PUNCT = {
  '-': ['Minus', false],
  _: ['Minus', true],
  '=': ['Equal', false],
  '+': ['Equal', true],
  '[': ['BracketLeft', false],
  '{': ['BracketLeft', true],
  ']': ['BracketRight', false],
  '}': ['BracketRight', true],
  '\\': ['Backslash', false],
  '|': ['Backslash', true],
  ';': ['Semicolon', false],
  ':': ['Semicolon', true],
  "'": ['Quote', false],
  '"': ['Quote', true],
  ',': ['Comma', false],
  '<': ['Comma', true],
  '.': ['Period', false],
  '>': ['Period', true],
  '/': ['Slash', false],
  '?': ['Slash', true],
  '`': ['Backquote', false],
  '~': ['Backquote', true],
  ' ': ['Space', false],
  '!': ['Digit1', true],
  '@': ['Digit2', true],
  '#': ['Digit3', true],
  $: ['Digit4', true],
  '%': ['Digit5', true],
  '^': ['Digit6', true],
  '&': ['Digit7', true],
  '*': ['Digit8', true],
  '(': ['Digit9', true],
  ')': ['Digit0', true],
};

/** Czech layout top row (unshifted gives letters, shifted gives digits). */
const CZ_TOP = {
  '+': ['Digit1', false],
  ě: ['Digit2', false],
  š: ['Digit3', false],
  č: ['Digit4', false],
  ř: ['Digit5', false],
  ž: ['Digit6', false],
  ý: ['Digit7', false],
  á: ['Digit8', false],
  í: ['Digit9', false],
  é: ['Digit0', false],
  '=': ['Minus', false],
  '%': ['Minus', true],
  '´': ['Equal', false],
  ú: ['BracketLeft', false],
  '/': ['BracketLeft', true],
  ')': ['BracketRight', false],
  '(': ['BracketRight', true],
  ů: ['Semicolon', false],
  '"': ['Semicolon', true],
  '§': ['Quote', false],
  '!': ['Quote', true],
  '¨': ['Backslash', false],
  "'": ['Backslash', true],
  '?': ['Comma', true],
  ':': ['Period', true],
  '-': ['Slash', false],
  _: ['Slash', true],
  ';': ['Backquote', false],
};

const NAMED_KEY = {
  Space: ' ',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Tab: 'Tab',
  Escape: 'Escape',
  Backspace: 'Backspace',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  ControlLeft: 'Control',
  ControlRight: 'Control',
  AltLeft: 'Alt',
  AltRight: 'Alt',
  MetaLeft: 'Meta',
  MetaRight: 'Meta',
};

function keyName(code, text) {
  if (text) return text;
  if (NAMED_KEY[code]) return NAMED_KEY[code];
  if (code.startsWith('Key')) return code.slice(3).toLowerCase();
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad') && /\d$/.test(code)) return code.slice(6);
  return code;
}

function modsFromParam(m) {
  const v = Math.max(0, (Number(m) || 1) - 1);
  return { shift: !!(v & 1), alt: !!(v & 2), ctrl: !!(v & 4), meta: !!(v & 8) };
}

const NO_MODS = { shift: false, alt: false, ctrl: false, meta: false };

/** Maps a single typed character to [code, isShifted] for the given legacy layout. */
export function codeForChar(ch, layout = 'us') {
  if (layout === 'cz' || layout === 'cz-qwertz') {
    if (CZ_TOP[ch]) return CZ_TOP[ch];
    if (/^[0-9]$/.test(ch)) return [`Digit${ch}`, true];
    if (layout === 'cz-qwertz') {
      if (ch === 'z') return ['KeyY', false];
      if (ch === 'Z') return ['KeyY', true];
      if (ch === 'y') return ['KeyZ', false];
      if (ch === 'Y') return ['KeyZ', true];
    }
  }
  if (/^[a-z]$/.test(ch)) return [`Key${ch.toUpperCase()}`, false];
  if (/^[A-Z]$/.test(ch)) return [`Key${ch}`, true];
  if (/^[0-9]$/.test(ch)) return [`Digit${ch}`, false];
  if (US_PUNCT[ch]) return US_PUNCT[ch];
  return ['', false];
}

function kittyCodeFor(n) {
  if (KITTY_FUNCTIONAL[n]) return KITTY_FUNCTIONAL[n];
  if (n >= 97 && n <= 122) return `Key${String.fromCharCode(n - 32)}`;
  if (n >= 48 && n <= 57) return `Digit${String.fromCharCode(n)}`;
  const ch = String.fromCodePoint(n);
  const p = US_PUNCT[ch];
  return p && !p[1] ? p[0] : '';
}

const EVENT_KIND = { 1: 'press', 2: 'repeat', 3: 'release' };

export class KeyParser {
  #buf = '';

  constructor({ layout = 'us' } = {}) {
    this.layout = layout;
  }

  /** True when the buffer ends in an ESC that may still start a sequence. */
  get hasPendingEscape() {
    return this.#buf.length > 0;
  }

  /** Treats whatever is buffered as complete (a lone ESC becomes Escape). */
  flush() {
    const rest = this.#buf;
    this.#buf = '';
    const out = [];
    if (rest === '\x1b') out.push(this.#key('Escape', 'press', NO_MODS, 'legacy'));
    else if (rest) out.push(...this.feed(rest, true));
    return out;
  }

  /** Parses a chunk; returns tokens and keeps an unfinished tail for next time. */
  feed(chunk, isFinal = false) {
    const s = this.#buf + chunk;
    this.#buf = '';
    const out = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '\x1b') {
        const next = s[i + 1];
        if (next === undefined) {
          if (isFinal) out.push(this.#key('Escape', 'press', NO_MODS, 'legacy'));
          else this.#buf = '\x1b';
          return out;
        }
        if (next === '[') {
          const m = /^\x1b\[([0-9:;<=>?]*)([ -/]*)([@-~])/.exec(s.slice(i));
          if (!m) {
            if (isFinal || s.length - i > 64) {
              i += 2;
              continue;
            }
            this.#buf = s.slice(i);
            return out;
          }
          out.push(...this.#csi(m[1], m[3]));
          i += m[0].length;
          continue;
        }
        if (next === 'O') {
          const f = s[i + 2];
          if (f === undefined) {
            if (isFinal) {
              out.push(this.#key('KeyO', 'press', { ...NO_MODS, alt: true }, 'legacy', 'O'));
              return out;
            }
            this.#buf = s.slice(i);
            return out;
          }
          if (LETTER[f]) out.push(this.#key(LETTER[f], 'press', NO_MODS, 'legacy'));
          i += 3;
          continue;
        }
        if (next === '\x1b') {
          out.push(this.#key('Escape', 'press', NO_MODS, 'legacy'));
          i += 1;
          continue;
        }
        // ESC + char = Alt + char
        const tok = this.#legacyChar(next);
        if (tok) {
          tok.mods.alt = true;
          out.push(tok);
        }
        i += 2;
        continue;
      }
      const cp = s.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      const tok = this.#legacyChar(ch);
      if (tok) out.push(tok);
      i += ch.length;
    }
    return out;
  }

  #key(code, kind, mods, source, text = '') {
    return { type: 'key', code, key: keyName(code, text), kind, mods: { ...mods }, source };
  }

  #legacyChar(ch) {
    const cp = ch.codePointAt(0);
    if (ch === '\r' || ch === '\n') return this.#key('Enter', 'press', NO_MODS, 'legacy');
    if (ch === '\t') return this.#key('Tab', 'press', NO_MODS, 'legacy');
    if (cp === 0x7f || cp === 0x08) return this.#key('Backspace', 'press', NO_MODS, 'legacy');
    if (cp === 0) return this.#key('Space', 'press', { ...NO_MODS, ctrl: true }, 'legacy', ' ');
    if (cp >= 1 && cp <= 26) {
      const letter = String.fromCharCode(cp + 64);
      return this.#key(`Key${letter}`, 'press', { ...NO_MODS, ctrl: true }, 'legacy', letter.toLowerCase());
    }
    if (cp >= 0x1c && cp <= 0x1f) {
      const code = ['Backslash', 'BracketRight', 'Digit6', 'Minus'][cp - 0x1c];
      return this.#key(code, 'press', { ...NO_MODS, ctrl: true }, 'legacy');
    }
    if (cp < 0x20) return null;
    const [code, isShifted] = codeForChar(ch, this.layout);
    return this.#key(code, 'press', { ...NO_MODS, shift: isShifted }, 'legacy', ch);
  }

  #csi(params, final) {
    // SGR mouse: CSI < b ; x ; y M|m
    if (params.startsWith('<') && (final === 'M' || final === 'm')) {
      const [b, x, y] = params.slice(1).split(';').map(Number);
      return [mouseToken(b, x, y, final === 'm')];
    }
    if (params.startsWith('?')) {
      if (final === 'u') return [{ type: 'kitty-flags', flags: Number(params.slice(1)) || 0 }];
      if (final === 'c') return [{ type: 'device-attributes' }];
      return [];
    }
    if (params === '' && final === 'I') return [{ type: 'focus', isFocused: true }];
    if (params === '' && final === 'O') return [{ type: 'focus', isFocused: false }];

    const fields = params.split(';');
    if (final === 'u') {
      // CSI code[:shifted[:base]] ; mods[:event] ; text u
      const [codes, modEvent = '1', text = ''] = fields;
      const [unshifted, shifted, base] = codes.split(':').map((v) => (v === '' ? undefined : Number(v)));
      const [m, ev] = modEvent.split(':');
      const mods = modsFromParam(m);
      const code = kittyCodeFor(base ?? unshifted) || kittyCodeFor(unshifted);
      let typed = text ? String.fromCodePoint(...text.split(':').map(Number)) : '';
      if (!typed && unshifted >= 32 && unshifted < 57344 && !mods.ctrl && !mods.alt) {
        typed = String.fromCodePoint(mods.shift && shifted ? shifted : unshifted);
      }
      return [this.#key(code, EVENT_KIND[ev] ?? 'press', mods, 'kitty', typed)];
    }
    const [first = '1', modEvent = '1'] = fields;
    const [m, ev] = modEvent.split(':');
    const mods = modsFromParam(m);
    const kind = EVENT_KIND[ev] ?? 'press';
    const source = ev ? 'kitty' : 'legacy';
    if (final === '~') {
      const code = TILDE[Number(first)];
      if (code === undefined) return [];
      return [this.#key(code, kind, mods, source)];
    }
    if (LETTER[final]) return [this.#key(LETTER[final], kind, mods, source)];
    return [];
  }
}

function mouseToken(b, x, y, isRelease) {
  const mods = { shift: !!(b & 4), alt: !!(b & 8), ctrl: !!(b & 16), meta: false };
  if (b & 64) {
    const step = (b & 1) === 0 ? -1 : 1;
    const isHorizontal = !!(b & 2);
    return { type: 'mouse', kind: 'wheel', button: -1, deltaX: isHorizontal ? step : 0, deltaY: isHorizontal ? 0 : step, x, y, mods };
  }
  const isMotion = !!(b & 32);
  const low = b & 3;
  const button = low === 3 ? -1 : low;
  const kind = isMotion ? 'move' : isRelease ? 'up' : 'down';
  return { type: 'mouse', kind, button, x, y, mods };
}
