import { cp, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'plugins', 'vscode-terminal');
const destination = path.join(root, 'src-tauri', 'resources', 'vscode-terminal');
const nodePtySource = path.join(root, 'node_modules', 'node-pty');
const nodePtyDestination = path.join(destination, 'node_modules', 'node-pty');
const platformPrebuild = `win32-${process.arch}`;
const prebuildSource = path.join(nodePtySource, 'prebuilds', platformPrebuild);
const prebuildDestination = path.join(nodePtyDestination, 'prebuilds', platformPrebuild);

if (process.platform !== 'win32') {
  throw new Error('The VS Code terminal plugin currently supports Windows only.');
}

await rm(destination, { recursive: true, force: true });
await mkdir(path.join(prebuildDestination, 'conpty'), { recursive: true });
await copyFile(path.join(source, 'host.cjs'), path.join(destination, 'host.cjs'));
await copyFile(path.join(source, 'plugin.json'), path.join(destination, 'plugin.json'));
await cp(path.join(nodePtySource, 'lib'), path.join(nodePtyDestination, 'lib'), { recursive: true });
await copyFile(path.join(prebuildSource, 'conpty.node'), path.join(prebuildDestination, 'conpty.node'));
await copyFile(
  path.join(prebuildSource, 'conpty', 'conpty.dll'),
  path.join(prebuildDestination, 'conpty', 'conpty.dll'),
);
await copyFile(
  path.join(prebuildSource, 'conpty', 'OpenConsole.exe'),
  path.join(prebuildDestination, 'conpty', 'OpenConsole.exe'),
);
await copyFile(path.join(nodePtySource, 'package.json'), path.join(nodePtyDestination, 'package.json'));
await copyFile(path.join(nodePtySource, 'LICENSE'), path.join(nodePtyDestination, 'LICENSE'));
await writeFile(path.join(destination, '.gitkeep'), '');

console.log(`Prepared system-Node VS Code terminal plugin for ${platformPrebuild}`);
