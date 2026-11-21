import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'plugins', 'vscode-terminal');
const destination = path.join(root, 'src-tauri', 'resources', 'vscode-terminal');
const nodePtySource = path.join(root, 'node_modules', 'node-pty');
// 交叉编译（例如在 Linux 容器里构建 Windows exe）时可显式指定目标平台。
const targetPlatform = process.env.TERMINAL_BUDDY_TARGET_PLATFORM ?? process.platform;
const platformPrebuild = `${targetPlatform}-${process.arch}`;
const prebuildSource = path.join(nodePtySource, 'prebuilds', platformPrebuild);

if (targetPlatform !== 'win32') {
  throw new Error(
    `The VS Code terminal plugin currently supports Windows only (target: ${targetPlatform}).`,
  );
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function computeCrc32(buffer) {
  if (typeof zlib.crc32 === 'function') {
    return zlib.crc32(buffer) >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function collectDirFiles(dir, relPrefix) {
  const entries = await readdir(dir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = `${relPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      result.push(...await collectDirFiles(abs, rel));
    } else if (entry.isFile()) {
      result.push({ relPath: rel, sourcePath: abs });
    }
  }
  return result;
}

function createDeterministicZip(items) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  // 固定 DOS 时间戳（1980-01-01 00:00:00），确保产物字节确定性。
  const dosTime = 0;
  const dosDate = 0x0021;
  const utf8Flag = 0x0800;

  for (const { relPath, data } of items) {
    const nameBytes = Buffer.from(relPath, 'utf8');
    const crc = computeCrc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate ? deflated : data;

    const localHeader = Buffer.allocUnsafe(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(utf8Flag, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBytes.copy(localHeader, 30);

    const centralHeader = Buffer.allocUnsafe(46 + nameBytes.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(utf8Flag, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBytes.copy(centralHeader, 46);

    localChunks.push(localHeader, payload);
    centralChunks.push(centralHeader);
    offset += localHeader.length + payload.length;
  }

  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const eocd = Buffer.allocUnsafe(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(items.length, 8);
  eocd.writeUInt16LE(items.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, ...centralChunks, eocd]);
}

const sourceEntries = [
  { relPath: 'host.cjs', sourcePath: path.join(source, 'host.cjs') },
  { relPath: 'plugin.json', sourcePath: path.join(source, 'plugin.json') },
  ...await collectDirFiles(path.join(nodePtySource, 'lib'), 'node_modules/node-pty/lib'),
  {
    relPath: `node_modules/node-pty/prebuilds/${platformPrebuild}/conpty.node`,
    sourcePath: path.join(prebuildSource, 'conpty.node'),
  },
  {
    relPath: `node_modules/node-pty/prebuilds/${platformPrebuild}/conpty/conpty.dll`,
    sourcePath: path.join(prebuildSource, 'conpty', 'conpty.dll'),
  },
  {
    relPath: `node_modules/node-pty/prebuilds/${platformPrebuild}/conpty/OpenConsole.exe`,
    sourcePath: path.join(prebuildSource, 'conpty', 'OpenConsole.exe'),
  },
  {
    relPath: 'node_modules/node-pty/package.json',
    sourcePath: path.join(nodePtySource, 'package.json'),
  },
  {
    relPath: 'node_modules/node-pty/LICENSE',
    sourcePath: path.join(nodePtySource, 'LICENSE'),
  },
].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

const items = await Promise.all(
  sourceEntries.map(async entry => ({
    relPath: entry.relPath,
    data: await readFile(entry.sourcePath),
  })),
);

const hash = createHash('sha256');
hash.update(`${targetPlatform}:${platformPrebuild}\n`);
for (const item of items) {
  hash.update(item.relPath);
  hash.update('\0');
  hash.update(item.data);
  hash.update('\0');
}
const stamp = hash.digest('hex');

const stampPath = path.join(destination, '.prepare-stamp');
const bundleZipPath = path.join(destination, 'bundle.zip');
const gitkeepPath = path.join(destination, '.gitkeep');

const allPresent = existsSync(stampPath)
  && existsSync(bundleZipPath)
  && existsSync(gitkeepPath)
  && items.every(item => existsSync(path.join(destination, ...item.relPath.split('/'))));

if (allPresent) {
  const previousStamp = await readFile(stampPath, 'utf8').catch(() => '');
  if (previousStamp.trim() === stamp) {
    console.log(`VS Code terminal plugin up-to-date for ${platformPrebuild}, skipping`);
    process.exit(0);
  }
}

const zipBuffer = createDeterministicZip(items);
const oldZipBuffer = await readFile(bundleZipPath).catch(() => null);
const zipUnchanged = oldZipBuffer !== null && oldZipBuffer.equals(zipBuffer);

if (zipUnchanged) {
  // zip 内容未变（例如仅缺失散落文件或 stamp），不覆写 bundle.zip 以保留 mtime，避免 Rust 重编。
  for (const item of items) {
    const destFile = path.join(destination, ...item.relPath.split('/'));
    await mkdir(path.dirname(destFile), { recursive: true });
    await writeFile(destFile, item.data);
  }
  await writeFile(gitkeepPath, '');
  await writeFile(stampPath, stamp);
} else {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const item of items) {
    const destFile = path.join(destination, ...item.relPath.split('/'));
    await mkdir(path.dirname(destFile), { recursive: true });
    await writeFile(destFile, item.data);
  }
  await writeFile(bundleZipPath, zipBuffer);
  await writeFile(gitkeepPath, '');
  await writeFile(stampPath, stamp);
}

console.log(
  `Prepared system-Node VS Code terminal plugin for ${platformPrebuild} (bundle.zip: ${(zipBuffer.length / 1024).toFixed(1)} KB)`,
);
