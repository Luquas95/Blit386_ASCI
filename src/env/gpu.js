// WebGPU for Bun via Dawn (the `webgpu` npm package). Installs navigator.gpu
// plus the GPU* globals, and fills in the two pieces a browser canvas would
// normally provide: the preferred canvas format and copyExternalImageToTexture.

import { createCanvas } from '@napi-rs/canvas';

const CANVAS_FORMAT = 'rgba8unorm';

function patchQueue(queue, unwrap) {
  if (queue.__blitTermPatched) return;
  queue.__blitTermPatched = true;
  queue.copyExternalImageToTexture = (src, dst, size) => {
    const [w, h] = Array.isArray(size) ? size : [size.width, size.height];
    const native = unwrap(src.source);
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    const ox = src.origin?.[0] ?? src.origin?.x ?? 0;
    const oy = src.origin?.[1] ?? src.origin?.y ?? 0;
    ctx.drawImage(native, -ox, -oy);
    const pixels = ctx.getImageData(0, 0, w, h).data;
    queue.writeTexture(
      { texture: dst.texture, mipLevel: dst.mipLevel ?? 0, origin: dst.origin ?? [0, 0, 0] },
      pixels,
      { bytesPerRow: w * 4, rowsPerImage: h },
      [w, h, 1],
    );
  };
}

/**
 * Tries to bring up Dawn. Returns a description of the adapter, or null when
 * WebGPU is unavailable (the engine then falls back to its software renderer).
 */
export async function installGpu({ unwrap, dawnOptions = [] }) {
  let mod;
  try {
    mod = await import('webgpu');
  } catch (err) {
    console.warn(`[blit-term] WebGPU module failed to load: ${err?.message ?? err}`);
    return null;
  }
  Object.assign(globalThis, mod.globals);
  const gpu = mod.create(dawnOptions);
  const probe = await gpu.requestAdapter().catch(() => null);
  if (!probe) {
    console.warn('[blit-term] No WebGPU adapter found');
    return null;
  }

  const requestAdapter = gpu.requestAdapter.bind(gpu);
  const wrappedGpu = {
    requestAdapter: async (opts) => {
      const adapter = await requestAdapter(opts);
      if (!adapter) return adapter;
      const requestDevice = adapter.requestDevice.bind(adapter);
      return new Proxy(adapter, {
        get(target, prop) {
          if (prop === 'requestDevice') {
            return async (desc) => {
              const device = await requestDevice(desc);
              patchQueue(device.queue, unwrap);
              device.addEventListener?.('uncapturederror', (e) => console.error('[blit-term] WebGPU error:', e.error?.message ?? e));
              return device;
            };
          }
          const v = Reflect.get(target, prop);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    },
    getPreferredCanvasFormat: () => CANVAS_FORMAT,
    get wgslLanguageFeatures() {
      return gpu.wgslLanguageFeatures ?? new Set();
    },
  };

  const info = probe.info ?? {};
  return { gpu: wrappedGpu, description: [info.vendor, info.description || info.architecture].filter(Boolean).join(' ') || 'unknown adapter' };
}
