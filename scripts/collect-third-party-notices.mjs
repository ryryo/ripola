import { readdir, readFile, mkdir, cp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Snapshot installed packages on this host, including development dependencies.
// This is an inventory and original notice archive, not a product license.
const root = fileURLToPath(new URL('../', import.meta.url));
const destination = join(root, 'docs/licenses');
await mkdir(destination, { recursive: true });
const catalog = new Map();
const licenseName = /^(licen[cs]e|copying|notice)([._-].*)?$/i;
const sha = data => createHash('sha256').update(data).digest('hex');
async function notices(directory, prefix = '') {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = join(prefix, entry.name);
    if (entry.isFile() && licenseName.test(entry.name)) found.push(name);
    // PDF.js ships font/CMap/WASM licenses outside its root package license.
    if (entry.isDirectory() && ['cmaps', 'standard_fonts', 'wasm', 'iccs'].includes(entry.name)) found.push(...await notices(join(directory, entry.name), name));
  }
  return found.sort();
}
async function record(directory) {
  let manifest;
  try { manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); } catch { return; }
  if (!manifest.name || !manifest.version) return;
  const key = `${manifest.name}@${manifest.version}`;
  if (catalog.has(key)) return;
  const files = [];
  for (const notice of await notices(directory)) {
    const target = join(destination, 'packages', key.replaceAll('/', '__'), notice);
    await mkdir(join(target, '..'), { recursive: true });
    await cp(join(directory, notice), target);
    const data = await readFile(target);
    files.push({ path: relative(root, target), sha256: sha(data), bytes: data.length });
  }
  catalog.set(key, { name: manifest.name, version: manifest.version, declaredLicense: manifest.license ?? manifest.licenses ?? null, repository: manifest.repository ?? null, notices: files, noticeStatus: files.length ? 'archived' : 'package contains no standalone notice file; see declared metadata and bundle notices' });
}
const store = join(root, 'node_modules/.pnpm');
for (const packageEntry of await readdir(store, { withFileTypes: true })) {
  if (!packageEntry.isDirectory() || packageEntry.name === 'node_modules') continue;
  const directory = join(store, packageEntry.name, 'node_modules');
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    if (entry.name.startsWith('@')) for (const child of await readdir(path, { withFileTypes: true })) { if (child.isDirectory()) await record(join(path, child.name)); }
    else await record(path);
  }
}
await mkdir(join(destination, 'bundles'), { recursive: true });
for (const environment of ['client', 'server']) await cp(join(root, `apps/web/dist/${environment}/THIRD-PARTY-LICENSES.md`), join(destination, `bundles/${environment}.md`));
const packages = [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
await writeFile(join(destination, 'catalog.json'), `${JSON.stringify({ scope: 'installed production and development packages on macOS arm64; platform-specific optional packages absent from this host are not archived; complete dependency versions remain in pnpm-lock.yaml', packages }, null, 2)}\n`);
console.log(`Archived notices for ${packages.length} installed packages; ${packages.filter(item => !item.notices.length).length} packages have no standalone notice file.`);
