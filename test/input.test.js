import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Input } from '../src/term/input.js';

class FakeStdin extends EventEmitter {
  isTTY = false;
  setEncoding() {}
  resume() {}
  pause() {}
}

function setup(opts = {}) {
  const stdin = new FakeStdin();
  const written = [];
  const stdout = { write: (s) => written.push(s) };
  const canvas = new EventTarget();
  const log = [];
  for (const type of ['keydown', 'keyup', 'pointerdown', 'pointermove', 'pointerup', 'wheel', 'blur']) {
    canvas.addEventListener(type, (e) => log.push({ type, code: e.code, repeat: e.repeat, x: e.clientX, y: e.clientY, buttons: e.buttons }));
  }
  const screen = { cellToCanvas: (col, row) => ({ x: col * 2, y: row * 4, isInside: true }) };
  let quits = 0;
  const input = new Input({ stdin, stdout, screen, targets: [canvas], canvas, onQuit: () => quits++, repeatDelayMs: 40, repeatWindowMs: 20, ...opts });
  input.start();
  return { stdin, written, log, input, quits: () => quits };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('legacy key hold emulation', () => {
  test('a single press is released after the repeat delay', async () => {
    const { stdin, log, input } = setup();
    stdin.emit('data', 'a');
    expect(log).toEqual([expect.objectContaining({ type: 'keydown', code: 'KeyA', repeat: false })]);
    await wait(60);
    expect(log.at(-1)).toMatchObject({ type: 'keyup', code: 'KeyA' });
    input.stop();
  });

  test('autorepeat keeps the key down, release follows the last repeat', async () => {
    const { stdin, log, input } = setup();
    stdin.emit('data', '\x1b[D');
    for (let i = 0; i < 4; i++) {
      await wait(10);
      stdin.emit('data', '\x1b[D');
    }
    expect(log.filter((e) => e.type === 'keyup')).toHaveLength(0);
    expect(log.filter((e) => e.type === 'keydown' && e.repeat)).toHaveLength(4);
    await wait(40);
    expect(log.at(-1)).toMatchObject({ type: 'keyup', code: 'ArrowLeft' });
    input.stop();
  });

  test('shift on a legacy key also holds ShiftLeft', async () => {
    const { stdin, log, input } = setup();
    stdin.emit('data', 'A');
    expect(log.map((e) => `${e.type}:${e.code}`)).toEqual(['keydown:ShiftLeft', 'keydown:KeyA']);
    await wait(70);
    expect(log.map((e) => `${e.type}:${e.code}`)).toContain('keyup:ShiftLeft');
    input.stop();
  });
});

describe('kitty protocol', () => {
  test('pushes flags when the terminal answers the query', () => {
    const { stdin, written, input } = setup();
    stdin.emit('data', '\x1b[?0u');
    expect(written.at(-1)).toBe('\x1b[>15u');
    input.stop();
    expect(written.at(-1)).toContain('\x1b[<u');
  });

  test('after the first real release, keys stay down until released', async () => {
    const { stdin, log, input } = setup();
    stdin.emit('data', '\x1b[97u\x1b[97;1:3u');
    stdin.emit('data', '\x1b[98u');
    await wait(80);
    expect(log.map((e) => `${e.type}:${e.code}`)).toEqual(['keydown:KeyA', 'keyup:KeyA', 'keydown:KeyB']);
    stdin.emit('data', '\x1b[98;1:3u');
    expect(log.at(-1)).toMatchObject({ type: 'keyup', code: 'KeyB' });
    input.stop();
  });
});

describe('quit, focus and mouse', () => {
  test('Ctrl+C quits in both protocols', () => {
    const { stdin, quits, input } = setup();
    stdin.emit('data', '\x03');
    stdin.emit('data', '\x1b[99;5u');
    expect(quits()).toBe(2);
    input.stop();
  });

  test('losing focus releases held keys', () => {
    const { stdin, log, input } = setup();
    stdin.emit('data', 'w');
    stdin.emit('data', '\x1b[O');
    expect(log.map((e) => `${e.type}:${e.code ?? ''}`)).toEqual(['keydown:KeyW', 'keyup:KeyW', 'blur:']);
    input.stop();
  });

  test('mouse becomes pointer events in canvas pixels', () => {
    const { stdin, log, input } = setup();
    stdin.emit('data', '\x1b[<0;10;5M\x1b[<32;11;5M\x1b[<0;11;5m\x1b[<65;1;1M');
    expect(log.map((e) => e.type)).toEqual(['pointerdown', 'pointermove', 'pointerup', 'wheel']);
    expect(log[0]).toMatchObject({ x: 20, y: 20, buttons: 1 });
    expect(log[1]).toMatchObject({ x: 22, buttons: 1 });
    expect(log[2]).toMatchObject({ buttons: 0 });
    input.stop();
  });
});
