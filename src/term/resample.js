// Frame resampling: canvas RGBA (any size) -> packed 0xRRGGBB grid of the
// size the terminal can show. Pure functions, no terminal I/O, easy to test.

/**
 * Picks the pixel grid to show the game in.
 * Fits the logical display (BT displaySize) into `availW` x `availH` pixels:
 * the largest whole-number zoom when it fits, otherwise a proportional shrink.
 *
 * @returns {{width:number, height:number, zoom:number}}
 */
export function fitGrid(logicalW, logicalH, availW, availH, zoom = 'auto') {
  if (typeof zoom === 'number' && zoom > 0) {
    return { width: Math.max(1, Math.round(logicalW * zoom)), height: Math.max(1, Math.round(logicalH * zoom)), zoom };
  }
  const fit = Math.min(availW / logicalW, availH / logicalH);
  if (fit >= 1) {
    const z = Math.floor(fit);
    return { width: logicalW * z, height: logicalH * z, zoom: z };
  }
  return {
    width: Math.max(1, Math.floor(logicalW * fit)),
    height: Math.max(1, Math.floor(logicalH * fit)),
    zoom: fit,
  };
}

/**
 * Resamples RGBA pixels into a packed RGB grid.
 * mode 'average' blends every source pixel that falls into a target pixel
 * (keeps thin lines and text visible when shrinking); 'nearest' takes one
 * sample per target pixel (crisp, but drops detail when shrinking).
 * Transparent pixels are composited over black.
 *
 * @param {{width:number, height:number, data:Uint8Array|Uint8ClampedArray}} frame
 * @param {number} tw target width in pixels
 * @param {number} th target height in pixels
 * @param {'average'|'nearest'} mode
 * @param {Uint32Array} [out] reused output buffer of tw*th
 */
export function resample(frame, tw, th, mode = 'average', out = new Uint32Array(tw * th)) {
  const { width: fw, height: fh, data } = frame;
  const sx = fw / tw;
  const sy = fh / th;
  const isShrinking = sx > 1 || sy > 1;

  for (let y = 0; y < th; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(fh, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor(x * sx);
      let r = 0;
      let g = 0;
      let b = 0;
      if (mode === 'nearest' || !isShrinking) {
        const px = Math.min(fw - 1, Math.floor((x + 0.5) * sx));
        const py = Math.min(fh - 1, Math.floor((y + 0.5) * sy));
        const i = (py * fw + px) * 4;
        const a = data[i + 3];
        r = (data[i] * a) / 255;
        g = (data[i + 1] * a) / 255;
        b = (data[i + 2] * a) / 255;
      } else {
        const x1 = Math.min(fw, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
        let n = 0;
        for (let yy = y0; yy < y1; yy++) {
          let i = (yy * fw + x0) * 4;
          for (let xx = x0; xx < x1; xx++, i += 4) {
            const a = data[i + 3];
            r += data[i] * a;
            g += data[i + 1] * a;
            b += data[i + 2] * a;
            n++;
          }
        }
        const k = 255 * n;
        r /= k;
        g /= k;
        b /= k;
      }
      out[y * tw + x] = ((r + 0.5) << 16) | ((g + 0.5) << 8) | (b + 0.5);
    }
  }
  return out;
}

const CUBE = [0, 95, 135, 175, 215, 255];

function nearestCube(v) {
  if (v < 48) return 0;
  if (v < 115) return 1;
  return Math.min(5, Math.floor((v - 35) / 40));
}

/** Maps 0xRRGGBB to the closest xterm-256 color index (6x6x6 cube or gray ramp). */
export function toXterm256(rgb) {
  const r = (rgb >> 16) & 255;
  const g = (rgb >> 8) & 255;
  const b = rgb & 255;
  const ri = nearestCube(r);
  const gi = nearestCube(g);
  const bi = nearestCube(b);
  const cr = CUBE[ri];
  const cg = CUBE[gi];
  const cb = CUBE[bi];
  const cubeDist = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
  const avg = (r + g + b) / 3;
  const gi2 = avg > 238 ? 23 : Math.max(0, Math.round((avg - 8) / 10));
  const gv = 8 + gi2 * 10;
  const grayDist = (r - gv) ** 2 + (g - gv) ** 2 + (b - gv) ** 2;
  return grayDist < cubeDist ? 232 + gi2 : 16 + 36 * ri + 6 * gi + bi;
}
