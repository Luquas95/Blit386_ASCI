// Terminal output: half-block (U+2580) cells, two game pixels per cell,
// truecolor or xterm-256 SGR, only changed cells are rewritten, and every
// frame goes out as one synchronized update so the terminal never tears.

import { fitGrid, resample, toXterm256 } from './resample.js';

const ESC = '\x1b[';
const UPPER_HALF = '▀';

export class Screen {
  #out;
  #opts;
  #prevTop = null;
  #prevBottom = null;
  #grid = null;
  #isWaitingForDrain = false;
  #isActive = false;
  layout = null;
  statusText = '';

  /**
   * @param {NodeJS.WriteStream} out
   * @param {{colors:'truecolor'|'256', scale:'average'|'nearest', zoom:'auto'|number, isStatusVisible:boolean}} opts
   */
  constructor(out, opts) {
    this.#out = out;
    this.#opts = opts;
  }

  get cols() {
    return this.#out.columns || 80;
  }

  get rows() {
    return this.#out.rows || 24;
  }

  enter() {
    this.#isActive = true;
    // Alternate screen, hidden cursor, no autowrap, clear.
    this.#out.write('\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J');
    this.#out.on('resize', this.invalidate);
  }

  leave() {
    if (!this.#isActive) return;
    this.#isActive = false;
    this.#out.off('resize', this.invalidate);
    this.#out.write('\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l');
  }

  /** Forces a full redraw on the next frame (resize, or the terminal got garbled). */
  invalidate = () => {
    this.#prevTop = null;
    this.#prevBottom = null;
    this.layout = null;
    if (this.#isActive) this.#out.write('\x1b[0m\x1b[2J');
  };

  #computeLayout(frame, logical) {
    const statusRows = this.#opts.isStatusVisible ? 1 : 0;
    const cols = this.cols;
    const rows = Math.max(1, this.rows - statusRows);
    const lw = logical?.x ?? frame.width;
    const lh = logical?.y ?? frame.height;
    const grid = fitGrid(lw, lh, cols, rows * 2, this.#opts.zoom);
    const width = Math.min(grid.width, cols);
    const height = Math.min(grid.height, rows * 2);
    const cellRows = Math.ceil(height / 2);
    return {
      cols,
      rows,
      statusRows,
      frameW: frame.width,
      frameH: frame.height,
      logicalW: lw,
      logicalH: lh,
      width,
      height,
      zoom: grid.zoom,
      cellRows,
      offsetX: Math.floor((cols - width) / 2),
      offsetY: Math.floor((rows - cellRows) / 2),
    };
  }

  /**
   * Maps a 1-based terminal cell to canvas pixel coordinates, or null when the
   * cell is outside the picture. Top half of a cell maps to the upper pixel.
   */
  cellToCanvas(col, row, isLowerHalf = false) {
    const l = this.layout;
    if (!l) return null;
    const gx = col - 1 - l.offsetX;
    const gy = (row - 1 - l.offsetY) * 2 + (isLowerHalf ? 1 : 0);
    const isInside = gx >= 0 && gy >= 0 && gx < l.width && gy < l.height;
    const cx = Math.min(l.width - 1, Math.max(0, gx));
    const cy = Math.min(l.height - 1, Math.max(0, gy));
    return {
      x: ((cx + 0.5) * l.frameW) / l.width,
      y: ((cy + 0.5) * l.frameH) / l.height,
      isInside,
    };
  }

  /** True while the terminal is still swallowing the previous frame. */
  get isBusy() {
    return this.#isWaitingForDrain;
  }

  /**
   * Draws one frame.
   * @param {{width:number, height:number, data:Uint8Array}} frame canvas pixels
   * @param {{x:number, y:number}|null} logical the game's displaySize
   */
  draw(frame, logical) {
    if (this.#isWaitingForDrain) return false;
    const want = this.#computeLayout(frame, logical);
    const l = this.layout;
    if (
      !l ||
      l.cols !== want.cols ||
      l.rows !== want.rows ||
      l.width !== want.width ||
      l.height !== want.height ||
      l.frameW !== want.frameW ||
      l.frameH !== want.frameH
    ) {
      if (l) this.#out.write('\x1b[0m\x1b[2J');
      this.layout = want;
      this.#prevTop = null;
      this.#prevBottom = null;
    }
    const { width, height, cellRows, offsetX, offsetY } = this.layout;
    if (!this.#grid || this.#grid.length !== width * height) this.#grid = new Uint32Array(width * height);
    const grid = resample(frame, width, height, this.#opts.scale, this.#grid);

    const cells = width * cellRows;
    const isFull = !this.#prevTop;
    if (isFull) {
      this.#prevTop = new Int32Array(cells).fill(-1);
      this.#prevBottom = new Int32Array(cells).fill(-1);
    }
    const prevTop = this.#prevTop;
    const prevBottom = this.#prevBottom;
    const is256 = this.#opts.colors === '256';
    const parts = ['\x1b[?2026h'];
    let fg = -1;
    let bg = -1;

    for (let cy = 0; cy < cellRows; cy++) {
      const topRow = cy * 2 * width;
      const hasBottom = cy * 2 + 1 < height;
      const bottomRow = topRow + width;
      let cursorX = -1;
      for (let x = 0; x < width; x++) {
        const top = grid[topRow + x];
        const bottom = hasBottom ? grid[bottomRow + x] : 0;
        const c = cy * width + x;
        if (prevTop[c] === top && prevBottom[c] === bottom) continue;
        prevTop[c] = top;
        prevBottom[c] = bottom;
        if (cursorX !== x) parts.push(`${ESC}${offsetY + cy + 1};${offsetX + x + 1}H`);
        if (top === bottom) {
          if (bg !== bottom) {
            parts.push(sgrBg(bottom, is256));
            bg = bottom;
          }
          parts.push(' ');
        } else {
          if (fg !== top) {
            parts.push(sgrFg(top, is256));
            fg = top;
          }
          if (bg !== bottom) {
            parts.push(sgrBg(bottom, is256));
            bg = bottom;
          }
          parts.push(UPPER_HALF);
        }
        cursorX = x + 1;
      }
    }

    if (this.#opts.isStatusVisible) {
      const text = ` ${this.statusText}`.slice(0, this.cols).padEnd(this.cols);
      parts.push(`\x1b[0m${ESC}${this.rows};1H\x1b[7m${text}\x1b[0m`);
      fg = -1;
      bg = -1;
    }
    parts.push('\x1b[0m\x1b[?2026l');
    if (parts.length <= 3 && !this.#opts.isStatusVisible) return true;
    const isFlushed = this.#out.write(parts.join(''));
    if (!isFlushed) {
      this.#isWaitingForDrain = true;
      this.#out.once('drain', () => {
        this.#isWaitingForDrain = false;
      });
    }
    return true;
  }
}

function sgrFg(rgb, is256) {
  return is256 ? `${ESC}38;5;${toXterm256(rgb)}m` : `${ESC}38;2;${(rgb >> 16) & 255};${(rgb >> 8) & 255};${rgb & 255}m`;
}

function sgrBg(rgb, is256) {
  return is256 ? `${ESC}48;5;${toXterm256(rgb)}m` : `${ESC}48;2;${(rgb >> 16) & 255};${(rgb >> 8) & 255};${rgb & 255}m`;
}
