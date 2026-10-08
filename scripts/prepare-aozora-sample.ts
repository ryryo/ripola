import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { importAozora, decodeAozoraHtml } from '../apps/web/src/reader/aozora-import.ts';

const sourceUrl = 'https://www.aozora.gr.jp/cards/000148/files/789_14547.html';
const sourceSha256 = '6d6f183529b1c4d87941e5d8c44a8d012beeedaba1cbe0fb5e586fcf38bd46df';
const input = process.argv[2];
const bytes = input ? await readFile(input) : new Uint8Array(await (await fetch(sourceUrl, { redirect: 'error', signal: AbortSignal.timeout(30000) })).arrayBuffer());
if (createHash('sha256').update(bytes).digest('hex') !== sourceSha256) throw new Error('The pinned Aozora source changed; review its provenance before updating this sample.');
const raw = decodeAozoraHtml(Uint8Array.from(bytes).buffer);
const draft = importAozora(raw, '吾輩は猫である', { sourceUrl, cardUrl: 'https://www.aozora.gr.jp/cards/000148/card789.html', sourceSha256 });
const counts = draft.provenance!.counts;
if (draft.provenance!.chapters.length !== 11 || counts.ruby !== 9214 || counts.gaiji !== 36 || counts.notes !== 6) throw new Error('The full-book structure does not match the reviewed source.');
const output = fileURLToPath(new URL('../apps/web/public/samples/wagahai.json', import.meta.url));
await mkdir(fileURLToPath(new URL('../apps/web/public/samples/', import.meta.url)), { recursive: true });
const json = JSON.stringify({ schemaVersion: 1, scope: 'full-text-eleven-chapters', draft }).replace(/</g, '\\u003c') + '\n';
await writeFile(output, json);
console.log(JSON.stringify({ bytes: Buffer.byteLength(json), blocks: draft.blocks.length, bodyCharacters: draft.blocks.reduce((sum, block) => sum + block.text.length, 0), chapters: 11, ...counts }));
