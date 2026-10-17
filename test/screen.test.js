import { describe, expect, test } from 'bun:test';
import { fitGrid, resample, toXterm256 } from '../src/term/resample.js';
import { Screen } from '../src/term/screen.js';
import { parseHalfBlocks } from './ansi-to-png.js';

function frameOf(w, h, fn) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a = 255] = fn(x, y);
      data.set([r, g, b, a], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

class FakeOut {
  chunks = [];
  constructor(cols, rows) {
    this.columns = cols;
    this.rows = rows;
  }
  write(s) {
    this.chunks.push(s);
    return true;
  }
  on() {}
  off() {}
  once() {}
}

describe('fitGrid', () => {
  test('largest whole zoom that fits', () => {
    expect(fitGrid(80, 60, 200, 130)).toEqual({ width: 160, height: 120, zoom: 2 });
    expect(fitGrid(320, 240, 320, 240)).toEqual({ width: 320, height: 240, zoom: 1 });
  });

  test('shrinks proportionally when too big', () => {
    const g = fitGrid(320, 240, 160, 120);
    expect([g.width, g.height]).toEqual([160, 120]);
    expect(g.zoom).toBe(0.5);
  });

  test('explicit zoom', () => {
    expect(fitGrid(100, 50, 10, 10, 3)).toMatchObject({ width: 300, height: 150 });
  });
});

describe('resample', () => {
  test('2x canvas down to logical size is exact', () => {
    const f = frameOf(4, 4, (x, y) => (x < 2 && y < 2 ? [255, 0, 0] : [0, 0, 255]));
    expect([...resample(f, 2, 2)]).toEqual([0xff0000, 0x0000ff, 0x0000ff, 0x0000ff]);
  });

  test('average keeps a one-pixel line visible when shrinking', () => {
    const f = frameOf(4, 1, (x) => (x === 1 ? [200, 200, 200] : [0, 0, 0]));
    const avg = resample(f, 2, 1, 'average');
    expect(avg[0]).toBe(0x646464);
    const near = resample(f, 2, 1, 'nearest');
    expect(near[0]).toBe(0xc8c8c8);
  });

  test('transparent pixels become black', () => {
    const f = frameOf(1, 1, () => [255, 255, 255, 0]);
    expect(resample(f, 1, 1)[0]).toBe(0);
  });
});

describe('toXterm256', () => {
  test('primaries and grays', () => {
    expect(toXterm256(0x000000)).toBe(16);
    expect(toXterm256(0xffffff)).toBe(231);
    expect(toXterm256(0xff0000)).toBe(196);
    expect(toXterm256(0x808080)).toBe(244);
  });
});

describe('Screen', () => {
  test('draws half blocks that decode back to the frame', () => {
    const out = new FakeOut(24, 10);
    const s = new Screen(out, { colors: 'truecolor', scale: 'average', zoom: 'auto', isStatusVisible: false });
    const f = frameOf(4, 4, (x, y) => [x * 60, y * 60, 100]);
    s.draw(f, { x: 4, y: 4 });
    // 24x10 cells = 24x20 px: zoom 5 -> 20x20 px = 20 cols x 10 rows, centered at col 2
    expect(s.layout).toMatchObject({ width: 20, height: 20, offsetX: 2, offsetY: 0 });
    const { top, bottom } = parseHalfBlocks(out.chunks.join(''), 24, 10);
    const cell = (cx, cy) => [top[cy * 24 + cx], bottom[cy * 24 + cx]];
    expect(cell(2, 0)).toEqual([[0, 0, 100], [0, 0, 100]]);
    expect(cell(2 + 19, 9)).toEqual([[180, 180, 100], [180, 180, 100]]);
    expect(cell(0, 0)).toEqual([null, null]);
  });

  test('second identical frame writes no cells', () => {
    const out = new FakeOut(10, 5);
    const s = new Screen(out, { colors: 'truecolor', scale: 'average', zoom: 'auto', isStatusVisible: false });
    const f = frameOf(10, 10, () => [1, 2, 3]);
    s.draw(f, { x: 10, y: 10 });
    out.chunks.length = 0;
    s.draw(f, { x: 10, y: 10 });
    expect(out.chunks.join('')).not.toContain('▀');
    expect(out.chunks.join('')).not.toContain('48;2');
  });

  test('only changed cells are rewritten', () => {
    const out = new FakeOut(10, 5);
    const s = new Screen(out, { colors: 'truecolor', scale: 'average', zoom: 'auto', isStatusVisible: false });
    s.draw(frameOf(10, 10, () => [0, 0, 0]), { x: 10, y: 10 });
    out.chunks.length = 0;
    s.draw(frameOf(10, 10, (x, y) => (x === 3 && y === 4 ? [255, 0, 0] : [0, 0, 0])), { x: 10, y: 10 });
    const text = out.chunks.join('');
    expect(text.match(/▀/g)).toHaveLength(1);
    expect(text).toContain('\x1b[3;4H');
  });

  test('cellToCanvas maps terminal cells to canvas pixels', () => {
    const out = new FakeOut(30, 10);
    const s = new Screen(out, { colors: 'truecolor', scale: 'average', zoom: 'auto', isStatusVisible: false });
    // canvas twice the logical size, like BLIT386's default drawingBufferSize;
    // zoom 5 -> 20x20 px picture starting at column 6
    s.draw(frameOf(8, 8, () => [0, 0, 0]), { x: 4, y: 4 });
    expect(s.cellToCanvas(6, 1)).toMatchObject({ x: 0.2, y: 0.2, isInside: true });
    expect(s.cellToCanvas(25, 10)).toMatchObject({ x: 7.8, y: 7.4, isInside: true });
    expect(s.cellToCanvas(1, 1).isInside).toBe(false);
  });

  test('256-color mode uses indexed SGR', () => {
    const out = new FakeOut(4, 2);
    const s = new Screen(out, { colors: '256', scale: 'average', zoom: 'auto', isStatusVisible: false });
    s.draw(frameOf(4, 4, () => [255, 0, 0]), { x: 4, y: 4 });
    expect(out.chunks.join('')).toContain('48;5;196m');
  });
});
