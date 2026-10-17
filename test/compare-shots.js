#!/usr/bin/env bun
// Compares blit-term frames with the reference screenshots the BLIT386 demos
// ship in public/shots (captured in Chrome by the demos' /shots page).
//
// Usage:
//   bun test/compare-shots.js --demos <demos-dir> [--backend webgpu|software]
//                              [--out <dir>] [slug ...]
//
// <demos-dir> is a copy of blit386/packages/demos with src/, public/ and
// _shots/poses.js, and node_modules/blit386 pointing at the engine version the
// shots were taken with (public/shots/manifest.json says which).
// For every pose without input it runs `blit-term --headless --at <seconds>`,
// shrinks the captured canvas to the logical display size and counts the
// pixels that differ from <pose>.display.png.

import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadImage, createCanvas } from '@napi-rs/canvas';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    demos: { type: 'string' },
    backend: { type: 'string', default: 'webgpu' },
    out: { type: 'string', default: 'shots-out' },
  },
});

if (!values.demos) {
  process.stderr.write('compare-shots: --demos <dir> is required\n');
  process.exit(2);
}

const demos = resolve(values.demos);
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
const manifest = await Bun.file(join(demos, 'public/shots/manifest.json')).json();
const { posesFor } = await import(join(demos, '_shots/poses.js'));
const cli = resolve(import.meta.dir, '../bin/blit-term.js');

async function pixels(file) {
  const img = await loadImage(file);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return { width: img.width, height: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
}

/** Differing pixels between reference (display size) and a frame of an integer multiple size. */
function diff(ref, got) {
  const kx = got.width / ref.width;
  const ky = got.height / ref.height;
  if (!Number.isInteger(kx) || !Number.isInteger(ky)) return { error: `size ${got.width}x${got.height} is not a multiple of ${ref.width}x${ref.height}` };
  let changed = 0;
  let total = 0;
  for (let y = 0; y < ref.height; y++) {
    for (let x = 0; x < ref.width; x++) {
      const i = (y * ref.width + x) * 4;
      const j = (y * ky * got.width + x * kx) * 4;
      const d = Math.abs(ref.data[i] - got.data[j]) + Math.abs(ref.data[i + 1] - got.data[j + 1]) + Math.abs(ref.data[i + 2] - got.data[j + 2]);
      if (d > 6) changed++;
      total++;
    }
  }
  return { changed, total, percent: (100 * changed) / total };
}

const slugs = positionals.length ? positionals : [...new Set(manifest.entries.map((e) => e.slug))];
const rows = [];
for (const slug of slugs) {
  for (const pose of posesFor(slug)) {
    const entry = manifest.entries.find((e) => e.slug === slug && e.pose === pose.id);
    if (!entry?.variants?.display) continue;
    if (pose.keys || pose.pointer || pose.touch) {
      rows.push({ slug, pose: pose.id, result: 'skipped (needs input)' });
      continue;
    }
    const png = join(out, `${slug}.${pose.id}.${values.backend}.png`);
    const proc = Bun.spawnSync(
      [process.execPath, cli, '--headless', '--dev', '--backend', values.backend, '--at', String(pose.at), '--query', 'embed&capture', '--png', png, '--log', join(out, `${slug}.${pose.id}.log`), join(demos, 'src', `${slug}.js`)],
      { stderr: 'pipe', stdout: 'pipe', timeout: 60_000 },
    );
    const summary = proc.stdout.toString().trim().split('\n').at(-1) ?? '';
    if (!existsSync(png)) {
      rows.push({ slug, pose: pose.id, result: `no frame (exit ${proc.exitCode}) ${summary}` });
      continue;
    }
    const ref = await pixels(join(demos, 'public/shots', entry.variants.display));
    const d = diff(ref, await pixels(png));
    let errors = 0;
    try {
      errors = JSON.parse(summary).errors;
    } catch {}
    rows.push({ slug, pose: pose.id, result: d.error ?? `${d.percent.toFixed(2)}% differ (${d.changed}/${d.total})`, errors });
  }
}

for (const r of rows) process.stdout.write(`${r.slug.padEnd(24)} ${r.pose.padEnd(10)} ${r.result}${r.errors ? `  [${r.errors} logged errors]` : ''}\n`);
