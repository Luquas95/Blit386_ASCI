import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage, storageFile } from '../src/env/storage.js';

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'blit-term-storage-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Storage', () => {
  test('behaves like the browser: strings in, strings out, null for missing keys', () => {
    const s = new Storage();
    s.setItem('n', 42);
    expect(s.getItem('n')).toBe('42');
    expect(s.getItem('missing')).toBeNull();
    expect(s.length).toBe(1);
    expect(s.key(0)).toBe('n');
    expect(s.key(5)).toBeNull();
    s.removeItem('n');
    expect(s.length).toBe(0);
  });

  test('a file-backed storage survives a restart', () => {
    const file = join(tempDir(), 'game.json');
    const a = new Storage(file);
    a.setItem('save', JSON.stringify({ level: 3 }));
    a.setItem('volume', '0.5');
    a.removeItem('volume');

    const b = new Storage(file);
    expect(JSON.parse(b.getItem('save'))).toEqual({ level: 3 });
    expect(b.getItem('volume')).toBeNull();

    b.clear();
    expect(new Storage(file).length).toBe(0);
  });

  test('creates the folder on the first save and writes plain JSON', () => {
    const file = join(tempDir(), 'deep', 'er', 'game.json');
    new Storage(file).setItem('k', 'v');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ k: 'v' });
  });

  test('an unreadable file starts empty instead of crashing the game', () => {
    const file = join(tempDir(), 'game.json');
    writeFileSync(file, '{broken');
    const s = new Storage(file);
    expect(s.length).toBe(0);
    s.setItem('k', 'v');
    expect(new Storage(file).getItem('k')).toBe('v');
  });

  test('a memory storage writes nothing', () => {
    const s = new Storage(null);
    s.setItem('k', 'v');
    expect(s.getItem('k')).toBe('v');
  });
});

describe('storageFile', () => {
  test('one file per project: named after the folder, told apart by its full path', () => {
    const a = storageFile('/state', '/home/me/games/Kulostrel');
    const b = storageFile('/state', '/tmp/Kulostrel');
    expect(a).toMatch(/^\/state\/Kulostrel-[0-9a-f]{8}\.json$/);
    expect(a).not.toBe(b);
    expect(storageFile('/state', '/home/me/games/Kulostrel')).toBe(a);
  });
});
