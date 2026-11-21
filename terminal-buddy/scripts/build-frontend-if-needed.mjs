import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const stampPath = path.join(root, 'node_modules', '.tmp', 'dist.build-stamp');

const CONFIG_FILES = [
  'index.html',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.node.json',
  'vite.config.ts',
];

async function collectFiles(dir, relPrefix) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await collectFiles(abs, rel));
    } else if (entry.isFile()) {
      files.push({ rel, abs });
    }
  }
  return files;
}

const inputFiles = [
  ...await collectFiles(path.join(root, 'src'), 'src'),
  ...CONFIG_FILES
    .map(name => ({ rel: name, abs: path.join(root, name) }))
    .filter(item => existsSync(item.abs)),
].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

const hash = createHash('sha256');
for (const file of inputFiles) {
  hash.update(file.rel);
  hash.update('\0');
  hash.update(await readFile(file.abs));
  hash.update('\0');
}
const inputHash = hash.digest('hex');

async function snapshotDist() {
  if (!existsSync(distDir)) return [];
  const entries = await collectFiles(distDir, '');
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return Promise.all(
    entries.map(async entry => ({
      rel: entry.rel,
      size: (await stat(entry.abs)).size,
    })),
  );
}

async function isDistUpToDate() {
  if (!existsSync(stampPath) || !existsSync(path.join(distDir, 'index.html'))) {
    return false;
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(stampPath, 'utf8'));
  } catch {
    return false;
  }
  if (parsed?.inputHash !== inputHash || !Array.isArray(parsed.distFiles) || parsed.distFiles.length === 0) {
    return false;
  }
  if (!parsed.distFiles.some(item => item?.rel === 'index.html')) {
    return false;
  }
  const current = await snapshotDist();
  if (current.length !== parsed.distFiles.length) {
    return false;
  }
  for (let i = 0; i < current.length; i += 1) {
    const a = current[i];
    const b = parsed.distFiles[i];
    if (!b || a.rel !== b.rel || a.size !== b.size) {
      return false;
    }
  }
  return true;
}

if (await isDistUpToDate()) {
  console.log('Frontend dist/ up-to-date, skipping tsc & vite build');
  process.exit(0);
}

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const res = spawnSync(npmCmd, ['run', 'build'], {
  stdio: 'inherit',
  cwd: root,
  shell: process.platform === 'win32',
});
if (res.error) {
  console.error(res.error);
  process.exit(1);
}
if (res.status !== 0) {
  process.exit(res.status ?? 1);
}

const distFiles = await snapshotDist();
await mkdir(path.dirname(stampPath), { recursive: true });
await writeFile(stampPath, JSON.stringify({ inputHash, distFiles }, null, 2));
