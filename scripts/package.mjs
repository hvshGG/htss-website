import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync(process.execPath, ['--env-file-if-exists=.env', path.join(root, 'scripts', 'build.mjs')], { cwd: root, stdio: 'inherit' });
const dist = path.join(root, 'dist');
const allowedRoot = new Set(['index.html', 'privacy.html', 'site-config.js', 'robots.txt', 'sitemap.xml',
  'CNAME', '.nojekyll', 'favicon.svg', 'icon.png', 'social-preview.svg']);
const entries = [];
async function collect(directory, prefix = '') {
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const name = prefix + item.name;
    if (item.isSymbolicLink()) throw new Error('Publication cannot contain symbolic links.');
    if (item.isDirectory()) {
      if (name !== 'assets' && !name.startsWith('assets/')) throw new Error('Unexpected directory in public output.');
      await collect(path.join(directory, item.name), `${name}/`);
    } else {
      if (!item.isFile() || (!allowedRoot.has(name) && !name.startsWith('assets/'))
        || name.split('/').some((part) => part === '..' || part === '.git' || part === 'node_modules' || part.startsWith('.env'))) {
        throw new Error('Unexpected private file in public output.');
      }
      entries.push({ name, data: await readFile(path.join(directory, item.name)) });
    }
  }
}
await collect(dist);
for (const required of allowedRoot) if (!entries.some(({ name }) => name === required)) throw new Error(`Missing public file: ${required}`);

// Small deterministic ZIP writer: UTF-8 names, DEFLATE, fixed DOS timestamp.
// The archive contains the CONTENTS of dist, so index.html is at the ZIP root.
const local = [];
const central = [];
let offset = 0;
for (const { name, data } of entries) {
  const filename = Buffer.from(name);
  const compressed = deflateRawSync(data);
  const useCompression = compressed.length < data.length;
  const content = useCompression ? compressed : data;
  const method = useCompression ? 8 : 0;
  const checksum = crc32(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(method, 8);
  header.writeUInt16LE(33, 12); header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(content.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
  local.push(header, filename, content);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50, 0);
  directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8);
  directory.writeUInt16LE(method, 10); directory.writeUInt16LE(33, 14); directory.writeUInt32LE(checksum, 16);
  directory.writeUInt32LE(content.length, 20); directory.writeUInt32LE(data.length, 24);
  directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
  central.push(directory, filename);
  offset += header.length + filename.length + content.length;
}
const directory = Buffer.concat(central);
const footer = Buffer.alloc(22);
footer.writeUInt32LE(0x06054b50, 0);
footer.writeUInt16LE(entries.length, 8); footer.writeUInt16LE(entries.length, 10);
footer.writeUInt32LE(directory.length, 12); footer.writeUInt32LE(offset, 16);
const archive = Buffer.concat([...local, directory, footer]);
const release = path.join(root, 'release');
const filename = path.join(release, 'htss-co-kz-ready.zip');
for (const target of [release, filename]) {
  const existing = await lstat(target).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
  if (existing?.isSymbolicLink()) throw new Error('Release output must not be a symbolic link.');
}
await mkdir(release, { recursive: true });
await writeFile(filename, archive);
console.log(`Ready: release/htss-co-kz-ready.zip (${entries.length} public files, ${archive.length} bytes).`);
