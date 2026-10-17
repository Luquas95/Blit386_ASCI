import { describe, expect, test } from 'bun:test';
import { codeForChar, KeyParser } from '../src/term/keys.js';

const keys = (input, opts) => new KeyParser(opts).feed(input, true).filter((t) => t.type === 'key');

describe('legacy input', () => {
  test('letters, digits and shift', () => {
    expect(keys('a')[0]).toMatchObject({ code: 'KeyA', key: 'a', kind: 'press', mods: { shift: false } });
    expect(keys('A')[0]).toMatchObject({ code: 'KeyA', key: 'A', mods: { shift: true } });
    expect(keys('7')[0]).toMatchObject({ code: 'Digit7', key: '7' });
    expect(keys('!')[0]).toMatchObject({ code: 'Digit1', mods: { shift: true } });
  });

  test('control keys', () => {
    expect(keys('\r')[0].code).toBe('Enter');
    expect(keys('\t')[0].code).toBe('Tab');
    expect(keys('\x7f')[0].code).toBe('Backspace');
    expect(keys(' ')[0]).toMatchObject({ code: 'Space', key: ' ' });
    expect(keys('\x03')[0]).toMatchObject({ code: 'KeyC', mods: { ctrl: true } });
  });

  test('arrows in CSI and SS3 form, with modifiers', () => {
    expect(keys('\x1b[A')[0].code).toBe('ArrowUp');
    expect(keys('\x1bOD')[0].code).toBe('ArrowLeft');
    expect(keys('\x1b[1;5C')[0]).toMatchObject({ code: 'ArrowRight', mods: { ctrl: true }, source: 'legacy' });
    expect(keys('\x1b[1;2B')[0]).toMatchObject({ code: 'ArrowDown', mods: { shift: true } });
  });

  test('function and editing keys', () => {
    expect(keys('\x1bOP')[0].code).toBe('F1');
    expect(keys('\x1b[15~')[0].code).toBe('F5');
    expect(keys('\x1b[24~')[0].code).toBe('F12');
    expect(keys('\x1b[3~')[0].code).toBe('Delete');
    expect(keys('\x1b[5~')[0].code).toBe('PageUp');
    expect(keys('\x1b[H')[0].code).toBe('Home');
  });

  test('alt + key and lone escape', () => {
    expect(keys('\x1bx')[0]).toMatchObject({ code: 'KeyX', mods: { alt: true } });
    expect(keys('\x1b')[0].code).toBe('Escape');
  });

  test('an unfinished sequence waits for more input', () => {
    const p = new KeyParser();
    expect(p.feed('\x1b[1;')).toEqual([]);
    expect(p.feed('5A')[0]).toMatchObject({ code: 'ArrowUp', mods: { ctrl: true } });
    expect(p.feed('\x1b')).toEqual([]);
    expect(p.hasPendingEscape).toBe(true);
    expect(p.flush()[0].code).toBe('Escape');
  });

  test('several keys in one chunk', () => {
    expect(keys('ab\x1b[Dc').map((t) => t.code)).toEqual(['KeyA', 'KeyB', 'ArrowLeft', 'KeyC']);
  });
});

describe('czech layouts', () => {
  test('top row maps to digit keys', () => {
    expect(codeForChar('ě', 'cz')).toEqual(['Digit2', false]);
    expect(codeForChar('é', 'cz')).toEqual(['Digit0', false]);
    expect(codeForChar('2', 'cz')).toEqual(['Digit2', true]);
  });

  test('qwertz swaps y and z', () => {
    expect(codeForChar('z', 'cz-qwertz')).toEqual(['KeyY', false]);
    expect(codeForChar('y', 'cz-qwertz')).toEqual(['KeyZ', false]);
    expect(codeForChar('z', 'cz')).toEqual(['KeyZ', false]);
  });

  test('parser uses the layout', () => {
    expect(keys('š', { layout: 'cz' })[0]).toMatchObject({ code: 'Digit3', key: 'š' });
  });
});

describe('kitty keyboard protocol', () => {
  test('press, repeat and release', () => {
    expect(keys('\x1b[97u')[0]).toMatchObject({ code: 'KeyA', kind: 'press', source: 'kitty', key: 'a' });
    expect(keys('\x1b[97;1:2u')[0]).toMatchObject({ code: 'KeyA', kind: 'repeat' });
    expect(keys('\x1b[97;1:3u')[0]).toMatchObject({ code: 'KeyA', kind: 'release' });
  });

  test('arrows and functional keys with event types', () => {
    expect(keys('\x1b[1;1:3D')[0]).toMatchObject({ code: 'ArrowLeft', kind: 'release', source: 'kitty' });
    expect(keys('\x1b[15;1:2~')[0]).toMatchObject({ code: 'F5', kind: 'repeat' });
    expect(keys('\x1b[57441u')[0]).toMatchObject({ code: 'ShiftLeft', key: 'Shift' });
    expect(keys('\x1b[57399u')[0].code).toBe('Numpad0');
  });

  test('base layout key wins for the physical code', () => {
    // Czech layout: the key that types "ě" sits where US has "2".
    expect(keys('\x1b[283::50u')[0]).toMatchObject({ code: 'Digit2', key: 'ě' });
    // QWERTZ "z" sits on the US "y" key.
    expect(keys('\x1b[122::121u')[0]).toMatchObject({ code: 'KeyY', key: 'z' });
  });

  test('modifiers and shifted text', () => {
    expect(keys('\x1b[97:65;2u')[0]).toMatchObject({ code: 'KeyA', key: 'A', mods: { shift: true } });
    expect(keys('\x1b[99;5u')[0]).toMatchObject({ code: 'KeyC', mods: { ctrl: true } });
    expect(keys('\x1b[13u')[0].code).toBe('Enter');
    expect(keys('\x1b[32u')[0]).toMatchObject({ code: 'Space', key: ' ' });
  });

  test('terminal replies', () => {
    const t = new KeyParser().feed('\x1b[?15u\x1b[?62;22c\x1b[O');
    expect(t).toEqual([{ type: 'kitty-flags', flags: 15 }, { type: 'device-attributes' }, { type: 'focus', isFocused: false }]);
  });
});

describe('SGR mouse', () => {
  test('press, drag, release and wheel', () => {
    const p = new KeyParser();
    expect(p.feed('\x1b[<0;10;5M')[0]).toMatchObject({ type: 'mouse', kind: 'down', button: 0, x: 10, y: 5 });
    expect(p.feed('\x1b[<32;11;5M')[0]).toMatchObject({ kind: 'move', button: 0 });
    expect(p.feed('\x1b[<35;12;6M')[0]).toMatchObject({ kind: 'move', button: -1 });
    expect(p.feed('\x1b[<0;12;6m')[0]).toMatchObject({ kind: 'up', button: 0 });
    expect(p.feed('\x1b[<2;1;1M')[0]).toMatchObject({ kind: 'down', button: 2 });
    expect(p.feed('\x1b[<64;1;1M')[0]).toMatchObject({ kind: 'wheel', deltaY: -1, deltaX: 0 });
    expect(p.feed('\x1b[<65;1;1M')[0]).toMatchObject({ kind: 'wheel', deltaY: 1 });
    expect(p.feed('\x1b[<66;1;1M')[0]).toMatchObject({ kind: 'wheel', deltaX: -1, deltaY: 0 });
    expect(p.feed('\x1b[<16;3;4M')[0]).toMatchObject({ kind: 'down', mods: { ctrl: true } });
  });
});
