// Web Storage (localStorage, sessionStorage) for Bun.
//
// localStorage keeps its data in a JSON file, one file per game project, so a game's saves and settings survive
// between runs just like in the browser. Like browser origins, two games never see each other's data: the file is
// named after the project folder plus a hash of its full path.
//
// sessionStorage, and localStorage when no file is wanted (headless runs, --no-storage), live in memory only.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** The same interface as the browser's Storage. Keys and values are always strings. */
export class Storage {
  /** @type {Map<string, string>} */
  #data;
  /** @type {string | null} */
  #file;

  /**
   * @param {string | null} [file] JSON file to load from and save to; null keeps everything in memory
   */
  constructor(file = null) {
    this.#file = file;
    this.#data = file ? load(file) : new Map();
  }

  get length() {
    return this.#data.size;
  }

  /** @param {number} index */
  key(index) {
    return [...this.#data.keys()][index] ?? null;
  }

  /** @param {string} key */
  getItem(key) {
    return this.#data.get(String(key)) ?? null;
  }

  /**
   * @param {string} key
   * @param {string} value
   */
  setItem(key, value) {
    this.#data.set(String(key), String(value));
    this.#save();
  }

  /** @param {string} key */
  removeItem(key) {
    if (this.#data.delete(String(key))) this.#save();
  }

  clear() {
    if (this.#data.size === 0) return;
    this.#data.clear();
    this.#save();
  }

  // Written at once, so nothing is lost when the game is closed with Ctrl+C or the terminal goes away. Games save
  // rarely (progress, settings), so the small cost does not matter. Write-then-rename keeps the old file intact if
  // writing fails halfway.
  #save() {
    if (!this.#file) return;
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.#data), null, 2));
      renameSync(tmp, this.#file);
    } catch (error) {
      console.warn(`[blit-term] could not save localStorage to ${this.#file}`, error);
    }
  }
}

/**
 * @param {string} file
 * @returns {Map<string, string>}
 */
function load(file) {
  if (!existsSync(file)) return new Map();
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('not a JSON object');
    return new Map(Object.entries(data).map(([k, v]) => [k, String(v)]));
  } catch (error) {
    console.warn(`[blit-term] ignoring unreadable localStorage file ${file}`, error);
    return new Map();
  }
}

/**
 * Where a project's localStorage file lives: <dir>/<project folder name>-<short hash of its full path>.json
 *
 * @param {string} dir
 * @param {string} projectDir
 * @returns {string}
 */
export function storageFile(dir, projectDir) {
  const hash = createHash('sha256').update(projectDir).digest('hex').slice(0, 8);
  const name = basename(projectDir).replace(/[^\w.-]/g, '_') || 'game';
  return join(dir, `${name}-${hash}.json`);
}

/**
 * Put localStorage, sessionStorage and the Storage class on globalThis.
 *
 * @param {object} opts
 * @param {string | null} opts.file localStorage file, or null for memory only
 * @returns {{ localStorage: Storage, sessionStorage: Storage }}
 */
export function installStorage({ file }) {
  const localStorage = new Storage(file);
  const sessionStorage = new Storage(null);
  for (const [name, value] of Object.entries({ Storage, localStorage, sessionStorage })) {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: false });
  }
  return { localStorage, sessionStorage };
}
