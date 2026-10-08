import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';

// All text is written for this project. No book or user document is included.
const directory = fileURLToPath(new URL('../apps/web/tests/fixtures/', import.meta.url));
await mkdir(directory, { recursive: true });
const fixedDate = new Date('2026-10-05T00:00:00Z');
async function create() {
  const document = await PDFDocument.create();
  document.setTitle('RSVP reader self-authored test fixture');
  document.setAuthor('rsvp-reader test');
  document.setCreationDate(fixedDate);
  document.setModificationDate(fixedDate);
  return document;
}
async function save(name, document) {
  await writeFile(`${directory}${name}`, await document.save({ useObjectStreams: false }));
}
function lines(page, font, strings, x = 48, top = 720) {
  strings.forEach((text, index) => page.drawText(text, { x, y: top - index * 18, size: 12, font, color: rgb(0.1, 0.1, 0.1) }));
}

const text = await create();
const font = await text.embedFont(StandardFonts.Helvetica);
lines(text.addPage([612, 792]), font, ['Morning reading begins here.', 'The same sentence is here.', 'The same sentence is here.']);
lines(text.addPage([612, 792]), font, ['This is the second page.', 'A final sentence ends the document.']);
await save('text-layer.pdf', text);

const image = await create();
const imagePage = image.addPage([612, 792]);
// An embedded 1x1 raster stands for a scan; there are no text operators.
const png = await image.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk1sAAAAASUVORK5CYII=', 'base64'));
imagePage.drawImage(png, { x: 48, y: 48, width: 516, height: 696 });
await save('image-only.pdf', image);

const partial = await create();
const partialFont = await partial.embedFont(StandardFonts.Helvetica);
lines(partial.addPage([612, 792]), partialFont, ['Only the first page has text.']);
partial.addPage([612, 792]);
await save('partial-blank.pdf', partial);

const blank = await create();
blank.addPage([612, 792]);
await save('blank.pdf', blank);

const columns = await create();
const columnsFont = await columns.embedFont(StandardFonts.Helvetica);
const columnsPage = columns.addPage([612, 792]);
lines(columnsPage, columnsFont, ['Left column one.', 'Left column two.', 'Left column three.', 'Left column four.'], 48);
lines(columnsPage, columnsFont, ['Right column one.', 'Right column two.', 'Right column three.', 'Right column four.'], 330);
await save('two-column.pdf', columns);

const rotated = await create();
const rotatedFont = await rotated.embedFont(StandardFonts.Helvetica);
rotated.addPage([612, 792]).drawText('Rotated text is unsupported.', { x: 200, y: 300, size: 12, font: rotatedFont, rotate: degrees(90) });
await save('rotated-text.pdf', rotated);

const one = await create();
const oneFont = await one.embedFont(StandardFonts.Helvetica);
lines(one.addPage([612, 792]), oneFont, ['Done.']);
await save('one-unit.pdf', one);

const many = await create();
const manyFont = await many.embedFont(StandardFonts.Helvetica);
for (let page = 0; page < 25; page++) lines(many.addPage([612, 792]), manyFont, Array.from({ length: 32 }, (_, line) => `Page ${page + 1} line ${line + 1}: This self-authored text checks cancellation.`));
await save('cancel-many-pages.pdf', many);

await writeFile(`${directory}invalid.pdf`, '%PDF-1.7\nThis deliberately invalid fixture has no objects or cross-reference.\n');
// Self-authored Japanese text with a standard non-embedded CID font. No OS font
// or third-party font binary is redistributed. ToUnicode maps only our characters.
const japaneseLines = ['私は朝の図書館で本を読む。', '一度止まり、原文を確かめる。'];
const hex = (value) => [...value].map(character => character.charCodeAt(0).toString(16).padStart(4, '0')).join('');
const mappings = [...new Set(japaneseLines.join(''))].map(character => `<${hex(character)}> <${hex(character)}>`);
const unicodeMap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /SelfAuthored def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${mappings.length} beginbfchar\n${mappings.join('\n')}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
const operators = `BT /F1 18 Tf 48 720 Td <${hex(japaneseLines[0])}> Tj 0 -28 Td <${hex(japaneseLines[1])}> Tj ET`;
const stream = value => `<< /Length ${Buffer.byteLength(value)} >>\nstream\n${value}\nendstream`;
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 8 0 R >>',
  '<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiKakuGo-W5 /Encoding /UniJIS-UCS2-H /DescendantFonts [5 0 R] /ToUnicode 7 0 R >>',
  '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiKakuGo-W5 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 5 >> /FontDescriptor 6 0 R /DW 1000 >>',
  '<< /Type /FontDescriptor /FontName /HeiseiKakuGo-W5 /Flags 4 /FontBBox [-100 -200 1200 1000] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>',
  stream(unicodeMap), stream(operators),
];
let japanesePdf = '%PDF-1.7\n';
const offsets = objects.map((value, index) => { const offset = Buffer.byteLength(japanesePdf); japanesePdf += `${index + 1} 0 obj\n${value}\nendobj\n`; return offset; });
const xref = Buffer.byteLength(japanesePdf);
japanesePdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
await writeFile(`${directory}japanese-text-layer.pdf`, japanesePdf);
console.log('Generated 10 self-authored PDF fixtures.');
