// <canvas>, OffscreenCanvas and Image backed by @napi-rs/canvas (Skia), plus a
// WebGPU canvas context that renders into a plain texture we can read back.

import { createCanvas, ImageData as NapiImageData, Image as NapiImage } from '@napi-rs/canvas';
import { Element } from './element.js';
import { readBytes } from './assets.js';

const unwrapKey = Symbol('blit-term.native');

/** Returns the Skia object behind one of our wrappers, or the value itself. */
export function unwrap(source) {
  return source?.[unwrapKey]?.() ?? source;
}

/**
 * Wraps a Skia 2D context so it accepts our canvas/image wrappers as image
 * sources and reports our element as `ctx.canvas`. Skia's own properties are
 * not configurable, hence a Proxy instead of patching the object.
 */
function patchContext2d(ctx, owner) {
  const overrides = {
    canvas: owner,
    drawImage: (src, ...rest) => ctx.drawImage(unwrap(src), ...rest),
    createPattern: (src, rep) => ctx.createPattern(unwrap(src), rep),
  };
  const bound = new Map();
  return new Proxy(ctx, {
    get(target, prop) {
      if (prop in overrides) return overrides[prop];
      const v = target[prop];
      if (typeof v !== 'function') return v;
      let fn = bound.get(prop);
      if (!fn) {
        fn = v.bind(target);
        bound.set(prop, fn);
      }
      return fn;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

function toBlob(napiCanvas, type = 'image/png', quality) {
  const mime = type === 'image/jpeg' || type === 'image/webp' ? type : 'image/png';
  const q = quality === undefined ? undefined : Math.round(quality * 100);
  return new Blob([napiCanvas.toBuffer(mime, q)], { type: mime });
}

/** Shared 2D backing: one Skia canvas resized whenever width/height change. */
class Backing2d {
  napi = null;
  ctx = null;

  constructor(owner, w, h) {
    this.owner = owner;
    this.w = w;
    this.h = h;
  }

  resize(w, h) {
    this.w = Math.max(1, w | 0);
    this.h = Math.max(1, h | 0);
    if (this.napi) {
      // Assigning a size clears the canvas, just like the browser does.
      this.napi.width = this.w;
      this.napi.height = this.h;
    }
  }

  context() {
    if (!this.napi) {
      this.napi = createCanvas(this.w, this.h);
      this.ctx = patchContext2d(this.napi.getContext('2d'), this.owner);
    }
    return this.ctx;
  }

  native() {
    if (!this.napi) this.context();
    return this.napi;
  }
}

function alignTo(n, a) {
  return Math.ceil(n / a) * a;
}

/** GPUCanvasContext replacement: the "swap chain" is one texture we own. */
export class GpuCanvasContext {
  #texture = null;
  #config = null;
  #readBuffer = null;
  #readBufferSize = 0;
  #isReading = false;

  constructor(canvas) {
    this.canvas = canvas;
  }

  configure(config) {
    this.#config = { ...config };
    this.#texture?.destroy();
    this.#texture = null;
  }

  unconfigure() {
    this.#texture?.destroy();
    this.#texture = null;
    this.#config = null;
  }

  getConfiguration() {
    return this.#config;
  }

  getCurrentTexture() {
    const c = this.#config;
    if (!c) throw new Error('GPUCanvasContext: configure() was not called');
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (!this.#texture || this.#texture.width !== w || this.#texture.height !== h) {
      this.#texture?.destroy();
      this.#texture = c.device.createTexture({
        label: 'blit-term canvas',
        size: [w, h],
        format: c.format,
        usage: (c.usage ?? 0) | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
    }
    return this.#texture;
  }

  /** Copies the last rendered frame to RGBA bytes; null while a read is still in flight. */
  async readPixels() {
    const tex = this.#texture;
    const c = this.#config;
    if (!tex || !c || this.#isReading) return null;
    this.#isReading = true;
    try {
      const w = tex.width;
      const h = tex.height;
      const bytesPerRow = alignTo(w * 4, 256);
      const size = bytesPerRow * h;
      if (!this.#readBuffer || this.#readBufferSize !== size) {
        this.#readBuffer?.destroy();
        this.#readBuffer = c.device.createBuffer({
          label: 'blit-term readback',
          size,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        this.#readBufferSize = size;
      }
      const enc = c.device.createCommandEncoder();
      enc.copyTextureToBuffer({ texture: tex }, { buffer: this.#readBuffer, bytesPerRow }, [w, h]);
      c.device.queue.submit([enc.finish()]);
      await this.#readBuffer.mapAsync(GPUMapMode.READ);
      const src = new Uint8Array(this.#readBuffer.getMappedRange());
      const out = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) out.set(src.subarray(y * bytesPerRow, y * bytesPerRow + w * 4), y * w * 4);
      this.#readBuffer.unmap();
      if (c.format.startsWith('bgra')) {
        for (let i = 0; i < out.length; i += 4) {
          const b = out[i];
          out[i] = out[i + 2];
          out[i + 2] = b;
        }
      }
      return { width: w, height: h, data: out };
    } finally {
      this.#isReading = false;
    }
  }
}

export class HTMLCanvasElement extends Element {
  #backing;
  #gpu = null;
  #kind = null;

  constructor() {
    super('canvas');
    this.#backing = new Backing2d(this, 300, 150);
  }

  get width() {
    return this.#backing.w;
  }

  set width(v) {
    this.#backing.resize(v, this.#backing.h);
  }

  get height() {
    return this.#backing.h;
  }

  set height(v) {
    this.#backing.resize(this.#backing.w, v);
  }

  getContext(kind) {
    if (kind === '2d') {
      if (this.#kind && this.#kind !== '2d') return null;
      this.#kind = '2d';
      return this.#backing.context();
    }
    if (kind === 'webgpu') {
      if (this.#kind && this.#kind !== 'webgpu') return null;
      if (typeof GPUTextureUsage === 'undefined') return null;
      this.#kind = 'webgpu';
      this.#gpu ??= new GpuCanvasContext(this);
      return this.#gpu;
    }
    return null;
  }

  /** Latest frame as RGBA, whichever context the engine picked. */
  async readFrame() {
    if (this.#kind === 'webgpu') return this.#gpu.readPixels();
    if (this.#kind === '2d') {
      const img = this.#backing.context().getImageData(0, 0, this.width, this.height);
      return { width: img.width, height: img.height, data: img.data };
    }
    return null;
  }

  getBoundingClientRect() {
    const w = this.width;
    const h = this.height;
    return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h };
  }

  toBlob(callback, type, quality) {
    queueMicrotask(() => callback(toBlob(this.#backing.native(), type, quality)));
  }

  toDataURL(type = 'image/png') {
    return this.#backing.native().toDataURL(type);
  }

  [unwrapKey]() {
    return this.#backing.native();
  }
}

export class OffscreenCanvas extends EventTarget {
  #backing;

  constructor(width, height) {
    super();
    this.#backing = new Backing2d(this, width, height);
  }

  get width() {
    return this.#backing.w;
  }

  set width(v) {
    this.#backing.resize(v, this.#backing.h);
  }

  get height() {
    return this.#backing.h;
  }

  set height(v) {
    this.#backing.resize(this.#backing.w, v);
  }

  getContext(kind) {
    return kind === '2d' ? this.#backing.context() : null;
  }

  async convertToBlob(options = {}) {
    return toBlob(this.#backing.native(), options.type, options.quality);
  }

  transferToImageBitmap() {
    const copy = createCanvas(this.width, this.height);
    copy.getContext('2d').drawImage(this.#backing.native(), 0, 0);
    return new ImageBitmap(copy);
  }

  [unwrapKey]() {
    return this.#backing.native();
  }
}

export class ImageBitmap {
  #source;

  constructor(source) {
    this.#source = source;
    this.width = source.width;
    this.height = source.height;
  }

  close() {}

  [unwrapKey]() {
    return this.#source;
  }
}

/** HTMLImageElement: loads through our asset resolver, decodes with Skia. */
export class Image extends Element {
  #native = null;
  #src = '';
  onload = null;
  onerror = null;
  complete = false;
  crossOrigin = null;
  decoding = 'auto';

  constructor(width, height) {
    super('img');
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    if (width !== undefined) this.width = width;
    if (height !== undefined) this.height = height;
  }

  get src() {
    return this.#src;
  }

  set src(value) {
    this.#src = String(value);
    this.complete = false;
    this.#load(this.#src);
  }

  async #load(url) {
    try {
      const bytes = await readBytes(url);
      const img = new NapiImage();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = Buffer.from(bytes);
      });
      if (url !== this.#src) return;
      this.#native = img;
      this.naturalWidth = img.width;
      this.naturalHeight = img.height;
      if (!this.width) this.width = img.width;
      if (!this.height) this.height = img.height;
      this.complete = true;
      const ev = new Event('load');
      this.onload?.(ev);
      this.dispatchEvent(ev);
    } catch (err) {
      if (url !== this.#src) return;
      this.complete = true;
      const ev = new Event('error');
      ev.error = err;
      console.error(`[blit-term] Image failed to load: ${url}: ${err?.message ?? err}`);
      this.onerror?.(ev);
      this.dispatchEvent(ev);
    }
  }

  decode() {
    if (this.complete && this.#native) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.addEventListener('load', () => resolve(), { once: true });
      this.addEventListener('error', (e) => reject(e.error ?? new Error('decode failed')), { once: true });
    });
  }

  [unwrapKey]() {
    return this.#native;
  }
}

export async function createImageBitmap(source, ...rest) {
  const native = unwrap(source);
  if (!native) throw new Error('createImageBitmap: source is not ready');
  let sx = 0;
  let sy = 0;
  let sw = native.width;
  let sh = native.height;
  if (typeof rest[0] === 'number') [sx, sy, sw, sh] = rest;
  const c = createCanvas(sw, sh);
  c.getContext('2d').drawImage(native, sx, sy, sw, sh, 0, 0, sw, sh);
  return new ImageBitmap(c);
}

export { NapiImageData as ImageData };
