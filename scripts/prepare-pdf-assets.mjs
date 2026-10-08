import { cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const distribution = dirname(require.resolve('pdfjs-dist/package.json'));
const destination = new URL('../apps/web/public/pdfjs/', import.meta.url);
await mkdir(destination, { recursive: true });
for (const name of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  await cp(join(distribution, name), new URL(name, destination), { recursive: true });
}
console.log('PDF.js assets prepared for same-origin loading.');
