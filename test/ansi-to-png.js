#!/usr/bin/env bun
// Renders half-block terminal output back into a PNG, so a terminal frame can
// be looked at (or diffed) as an image. Understands what blit-term emits and
// what `tmux capture-pane -e` returns: CUP cursor moves, newlines, truecolor
// and 256-color SGR, U+2580 and spaces. Every cell becomes 1x2 pixels.
//
// Usage: bun test/ansi-to-png.js <input.ansi> <output.png> [cols] [rows]

import { readFileSync, writeFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

export function xterm256ToRgb(n) {
  const base = [
    [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
    [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
  ];
  if (n < 16) return base[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return [v, v, v];
  }
  const i = n - 16;
  const c = [0, 95, 135, 175, 215, 255];
  return [c[Math.floor(i / 36)], c[Math.floor(i / 6) % 6], c[i % 6]];
}

/** Parses terminal output into a grid of [topRgb, bottomRgb] cells. */
export function parseHalfBlocks(text, cols, rows) {
  const top = new Array(cols * rows).fill(null);
  const bottom = new Array(cols * rows).fill(null);
  let x = 0;
  let y = 0;
  let fg = [229, 229, 229];
  let bg = [0, 0, 0];
  const sgr = (params) => {
    const p = params === '' ? [0] : params.split(';').map(Number);
    for (let i = 0; i < p.length; i++) {
      const v = p[i];
      if (v === 0) {
        fg = [229, 229, 229];
        bg = [0, 0, 0];
      } else if ((v === 38 || v === 48) && p[i + 1] === 2) {
        const rgb = [p[i + 2], p[i + 3], p[i + 4]];
        if (v === 38) fg = rgb;
        else bg = rgb;
        i += 4;
      } else if ((v === 38 || v === 48) && p[i + 1] === 5) {
        const rgb = xterm256ToRgb(p[i + 2]);
        if (v === 38) fg = rgb;
        else bg = rgb;
        i += 2;
      } else if (v === 39) fg = [229, 229, 229];
      else if (v === 49) bg = [0, 0, 0];
    }
  };
  const re = /\x1b\[([0-9;?<>=]*)([@-~])|\n|\r|[^\x1b\n\r]/gu;
  for (const m of text.matchAll(re)) {
    const s = m[0];
    if (s === '\n') {
      y++;
      x = 0;
    } else if (s === '\r') x = 0;
    else if (m[2] !== undefined) {
      if (m[2] === 'm' && !m[1].startsWith('?')) sgr(m[1]);
      else if (m[2] === 'H') {
        const [r = 1, c = 1] = m[1].split(';').map((v) => Number(v) || 1);
        y = r - 1;
        x = c - 1;
      } else if (m[2] === 'J' && m[1] === '2') {
        top.fill(null);
        bottom.fill(null);
      }
    } else {
      if (x < cols && y < rows) {
        const i = y * cols + x;
        if (s === '▀') {
          top[i] = fg;
          bottom[i] = bg;
        } else if (s === ' ') {
          top[i] = bg;
          bottom[i] = bg;
        } else {
          top[i] = fg;
          bottom[i] = fg;
        }
      }
      x++;
    }
  }
  return { top, bottom };
}

if (import.meta.main) {
  const [input, output, colsArg, rowsArg] = process.argv.slice(2);
  if (!input || !output) {
    process.stderr.write('Usage: bun test/ansi-to-png.js <input.ansi> <output.png> [cols] [rows]\n');
    process.exit(2);
  }
  const text = readFileSync(input, 'utf8');
  const cols = Number(colsArg) || Math.max(...text.split('\n').map((l) => l.replace(/\x1b\[[0-9;?<>=]*[@-~]/g, '').length));
  const rows = Number(rowsArg) || text.split('\n').length;
  const { top, bottom } = parseHalfBlocks(text, cols, rows);
  const c = createCanvas(cols, rows * 2);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(cols, rows * 2);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      for (const [rgb, dy] of [[top[i], 0], [bottom[i], 1]]) {
        const j = ((y * 2 + dy) * cols + x) * 4;
        const v = rgb ?? [0, 0, 0];
        img.data[j] = v[0];
        img.data[j + 1] = v[1];
        img.data[j + 2] = v[2];
        img.data[j + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  writeFileSync(output, c.toBuffer('image/png'));
}
