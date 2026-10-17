// Asset loading: the game asks for URLs as if it ran on a Vite dev server.
// We answer them from the project's files instead of the network:
//   http://blit.local/<path>  ->  <project>/public/<path>, then <project>/<path>
//   blob:blit/<n>             ->  in-memory Blob created by URL.createObjectURL
//   data:...                  ->  decoded in place
// Anything else (real http/https) goes to Bun's own fetch.

import { existsSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';

export const ORIGIN = 'http://blit.local';

const blobs = new Map();
let blobCounter = 0;
let roots = [];
let nativeFetch = globalThis.fetch;

export function configureAssets({ publicDir, rootDir }) {
  roots = [publicDir, rootDir].filter((d) => d && existsSync(d));
}

function insideRoot(root, file) {
  const r = normalize(root + sep);
  return normalize(file).startsWith(r);
}

/** Maps a local URL to a file on disk, or null when no root has it. */
export function resolveLocalFile(url) {
  const u = new URL(url, `${ORIGIN}/`);
  if (u.origin !== ORIGIN) return null;
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  for (const root of roots) {
    const file = join(root, rel);
    if (!insideRoot(root, file)) continue;
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

function createObjectURL(blob) {
  const url = `blob:blit/${++blobCounter}`;
  blobs.set(url, blob);
  return url;
}

function revokeObjectURL(url) {
  blobs.delete(url);
}

/** Reads any URL the game may use and returns its bytes. */
export async function readBytes(url) {
  const s = typeof url === 'string' ? url : String(url);
  if (blobs.has(s)) return new Uint8Array(await blobs.get(s).arrayBuffer());
  if (s.startsWith('data:')) return new Uint8Array(await (await nativeFetch(s)).arrayBuffer());
  const res = await blitFetch(s);
  if (!res.ok) throw new Error(`Can't load '${s}' (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

async function blitFetch(input, init) {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (blobs.has(raw)) return new Response(blobs.get(raw));
  if (raw.startsWith('data:')) return nativeFetch(raw, init);
  const abs = new URL(raw, `${ORIGIN}/`);
  if (abs.origin !== ORIGIN) return nativeFetch(input, init);
  const file = resolveLocalFile(abs.href);
  if (!file) {
    console.warn(`[blit-term] Asset not found: ${abs.pathname} (looked in ${roots.join(', ')})`);
    return new Response('Not found', { status: 404, statusText: 'Not Found' });
  }
  return new Response(Bun.file(file));
}

export function installAssets() {
  nativeFetch = globalThis.fetch;
  globalThis.fetch = blitFetch;
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
}
