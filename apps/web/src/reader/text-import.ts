import { resolveDocumentTitle } from './document-title';
import { decodeNamedCharacterReference } from 'decode-named-character-reference';
import type { Nodes, Root } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { MAX_INPUT_BYTES, MAX_TEXT_LENGTH } from './model';
import type { DraftDocument, RubySpan, SourceRun, TextBlock } from './model';

const markdown = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml', 'toml']);
const escapable = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/;

function sourceBounds(node: Nodes): [number, number] {
  return [node.position?.start.offset ?? 0, node.position?.end.offset ?? 0];
}

/** Input is never normalized or overwritten; all offsets use its UTF-16 positions. */
export function validateText(raw: string): void {
  if (raw.length > MAX_TEXT_LENGTH) throw new Error('本文は100万文字以内にしてください。');
  if (new TextEncoder().encode(raw).byteLength > MAX_INPUT_BYTES) throw new Error('ファイルは20MiB以内にしてください。');
  if (!raw.trim()) throw new Error('本文が空です。文字のあるTXT・Markdown、または貼り付けを使ってください。');
}

export class InlineBuilder {
  text = '';
  runs: SourceRun[] = [];
  ruby: RubySpan[] = [];

  append(text: string, start: number, end: number, mapping: SourceRun['mapping'] = 'exact'): void {
    if (!text) return;
    const run: SourceRun = { start: this.text.length, end: this.text.length + text.length, sources: [{ kind: 'text', start, end }], mapping };
    const last = this.runs.at(-1);
    const previous = last?.sources[0];
    // Compact ordinary text runs. Transformed entities keep their own full source range.
    if (mapping === 'exact' && last?.mapping === 'exact' && previous?.kind === 'text' && previous.end === start && last.end === run.start) {
      last.end = run.end;
      previous.end = end;
    } else this.runs.push(run);
    this.text += text;
  }

  decoded(raw: string, sourceStart: number, escapes: boolean): void {
    let cursor = 0;
    let exactStart = 0;
    const flush = () => {
      if (exactStart < cursor) this.append(raw.slice(exactStart, cursor), sourceStart + exactStart, sourceStart + cursor);
    };
    while (cursor < raw.length) {
      let consumed = 0;
      let value: string | undefined;
      if (escapes && raw[cursor] === '\\' && raw[cursor + 1] && escapable.test(raw[cursor + 1])) {
        consumed = 2;
        value = raw[cursor + 1];
      } else if (raw[cursor] === '\r') {
        consumed = raw[cursor + 1] === '\n' ? 2 : 1;
        value = '\n';
      } else if (raw[cursor] === '&') {
        const entity = /^&(#(?:x[0-9a-f]{1,6}|[0-9]{1,7})|[a-z][a-z0-9]{0,31});/i.exec(raw.slice(cursor));
        if (entity) {
          const name = entity[1];
          if (name.startsWith('#')) {
            const hexadecimal = name[1].toLowerCase() === 'x';
            const number = Number.parseInt(name.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
            value = number === 0 || number > 0x10ffff || (number >= 0xd800 && number <= 0xdfff) ? '\uFFFD' : String.fromCodePoint(number);
          } else {
            const decoded = decodeNamedCharacterReference(name);
            if (decoded !== false) value = decoded;
          }
          if (value !== undefined) consumed = entity[0].length;
        }
      }
      if (value !== undefined) {
        flush();
        this.append(value, sourceStart + cursor, sourceStart + cursor + consumed, 'transformed');
        cursor += consumed;
        exactStart = cursor;
      } else cursor++;
    }
    flush();
  }

  appendBuilder(other: InlineBuilder): void {
    const shift = this.text.length;
    this.text += other.text;
    this.runs.push(...other.runs.map((run) => ({ ...run, start: run.start + shift, end: run.end + shift })));
    this.ruby.push(...other.ruby.map((span) => ({ ...span, start: span.start + shift, end: span.end + shift })));
  }
}

/** Tiny inert ruby grammar: plain base/rt/rp/rb only; no DOM, attributes or HTML execution. */
function parseRuby(raw: string, sourceStart: number): InlineBuilder | undefined {
  const builder = new InlineBuilder();
  const tokens = [...raw.matchAll(/<[^>]*>|[^<]+/g)];
  let inRuby = false;
  let inReading = false;
  let inParenthesis = false;
  let reading = '';
  let baseStart = 0;
  let tokenEnd = 0;
  for (const token of tokens) {
    if (token.index !== tokenEnd) return undefined;
    tokenEnd += token[0].length;
    const value = token[0];
    if (value.startsWith('<')) {
      const tag = /^<\s*(\/?)\s*(ruby|rt|rp|rb)\s*>$/i.exec(value);
      if (!tag) return undefined;
      const close = tag[1] === '/';
      switch (tag[2].toLowerCase()) {
        case 'ruby':
          if (!close && inRuby) return undefined;
          if (close && (!inRuby || inReading || inParenthesis)) return undefined;
          inRuby = !close;
          break;
        case 'rt':
          if (!inRuby || inParenthesis || (!close && inReading) || (close && !inReading)) return undefined;
          if (close) {
            if (builder.text.length > baseStart && reading.trim()) builder.ruby.push({ start: baseStart, end: builder.text.length, reading: reading.trim() });
            baseStart = builder.text.length;
            reading = '';
          }
          inReading = !close;
          break;
        case 'rp':
          if (!inRuby || inReading) return undefined;
          inParenthesis = !close;
          break;
        case 'rb':
          if (!inRuby || inReading || inParenthesis) return undefined;
          break;
      }
    } else {
      if (!inRuby) return undefined;
      const decoded = new InlineBuilder();
      decoded.decoded(value, sourceStart + (token.index ?? 0), false);
      if (inReading) reading += decoded.text;
      else if (!inParenthesis) builder.appendBuilder(decoded);
    }
  }
  if (tokenEnd !== raw.length || inRuby || inReading || inParenthesis || !builder.text) return undefined;
  return builder;
}

function inline(nodes: Nodes[], raw: string, warnings: Set<string>): InlineBuilder {
  const builder = new InlineBuilder();
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    const [start, end] = sourceBounds(node);
    if (node.type === 'html' && /^<ruby(?:\s[^<>]*)?>$/i.test(node.value.trim())) {
      let closing = index + 1;
      while (closing < nodes.length && !(nodes[closing].type === 'html' && /^<\/ruby\s*>$/i.test((nodes[closing] as { value: string }).value.trim()))) closing++;
      if (closing < nodes.length) {
        const [, rubyEnd] = sourceBounds(nodes[closing]);
        // Markdown strips quote/list continuation prefixes from text node values.
        // Passing their raw source to the ruby grammar would silently add those markers
        // to the base text. Keep this complex form only in rawText in the initial version.
        const hasContinuationPrefix = nodes.slice(index + 1, closing).some((child) => {
          if (child.type !== 'text') return false;
          const [childStart, childEnd] = sourceBounds(child);
          const source = raw.slice(childStart, childEnd);
          if (!/(?:\r\n|\r|\n)[\t ]*(?:>|[\t ])/u.test(source)) return false;
          const decoded = new InlineBuilder();
          decoded.decoded(source, childStart, true);
          return decoded.text !== child.value;
        });
        if (hasContinuationPrefix) warnings.add('引用・リストの継続記号を含む複数行ルビは再生本文から除外しました。元の入力で確認できます。');
        else {
          const ruby = parseRuby(raw.slice(start, rubyEnd), start);
          if (ruby) builder.appendBuilder(ruby);
          else warnings.add('解釈できないルビ構造を再生本文から除外しました。原文で確認できます。');
        }
        index = closing;
        continue;
      }
      warnings.add('閉じられていないルビ以降の段落部分を再生本文から除外しました。原文で確認してください。');
      break;
    }
    if (node.type === 'html') {
      // Dangerous element contents are excluded too. All HTML remains inert in rawText.
      const unsafe = /^<(script|style|iframe|object|svg)(?:\s|>)/i.exec(node.value);
      if (unsafe) {
        const close = new RegExp(`</${unsafe[1]}\\s*>`, 'i');
        if (!close.test(node.value)) while (index + 1 < nodes.length) { index++; if (nodes[index].type === 'html' && close.test((nodes[index] as { value: string }).value)) break; }
      }
      warnings.add('ルビ以外のHTMLタグは実行せず、再生本文から除外しています。');
    } else if (node.type === 'text') {
      const decoded = new InlineBuilder();
      decoded.decoded(raw.slice(start, end), start, true);
      if (decoded.text === node.value) builder.appendBuilder(decoded);
      else builder.append(node.value, start, end, 'approximate');
    } else if (node.type === 'inlineCode') {
      const slice = raw.slice(start, end);
      const fence = /^`+/.exec(slice)?.[0].length ?? 0;
      const content = slice.slice(fence, slice.length - fence);
      if (content === node.value) builder.append(content, start + fence, end - fence);
      else builder.append(node.value, start, end, 'transformed');
    } else if (node.type === 'break') {
      builder.append('\n', start, end, 'transformed');
    } else if (node.type === 'image' || node.type === 'imageReference') {
      warnings.add('画像・altは再生本文から除外しています。');
    } else if (node.type === 'footnoteReference') {
      warnings.add('脚注の参照と本文は再生本文から除外しています。');
    } else if ('children' in node) builder.appendBuilder(inline(node.children as Nodes[], raw, warnings));
  }
  return builder;
}

export function importText(raw: string, format: 'txt' | 'md', title: string): DraftDocument {
  validateText(raw);
  const blocks: TextBlock[] = [];
  const warnings = new Set<string>();
  const add = (kind: TextBlock['kind'], builder: InlineBuilder, start: number, level?: number) => {
    if (!builder.text.trim()) return;
    blocks.push({ id: `block-${start}-${blocks.length}`, kind, text: builder.text, runs: builder.runs, ruby: builder.ruby, ...(level ? { level } : {}) });
  };
  if (format === 'txt') {
    let cursor = 0;
    for (const separator of raw.matchAll(/(?:\r\n|\n|\r(?!\n))[\t ]*(?:\r\n|\n|\r(?!\n))/g)) {
      const end = separator.index;
      const builder = new InlineBuilder();
      builder.append(raw.slice(cursor, end), cursor, end);
      add('paragraph', builder, cursor);
      cursor = end + separator[0].length;
    }
    const builder = new InlineBuilder();
    builder.append(raw.slice(cursor), cursor, raw.length);
    add('paragraph', builder, cursor);
  } else {
    const tree = markdown.parse(raw) as Root;
    const visit = (node: Nodes, context?: 'quote' | 'listItem') => {
      const [start, end] = sourceBounds(node);
      if (node.type === 'paragraph' || node.type === 'heading') {
        add(node.type === 'heading' ? 'heading' : context ?? 'paragraph', inline(node.children, raw, warnings), start, node.type === 'heading' ? node.depth : undefined);
      } else if (node.type === 'code' || node.type === 'table') {
        const builder = new InlineBuilder();
        // Static blocks preserve source syntax, including code fences and table layout.
        builder.append(raw.slice(start, end), start, end);
        add(node.type, builder, start);
      } else if (node.type === 'html') {
        const ruby = parseRuby(node.value, start);
        if (ruby) add(context ?? 'paragraph', ruby, start);
        else warnings.add('ルビ以外のHTMLブロックは再生本文から除外しています。原文で確認できます。');
      } else if (['definition', 'footnoteDefinition', 'yaml', 'toml'].includes(node.type)) {
        warnings.add('frontmatter・リンク定義・脚注本文は再生本文から除外しています。');
      } else if ('children' in node) {
        const next = node.type === 'blockquote' ? 'quote' : node.type === 'listItem' ? 'listItem' : context;
        for (const child of node.children) visit(child as Nodes, next);
      }
    };
    visit(tree);
  }
  if (!blocks.length) throw new Error(`再生できる本文がありません。本文のあるTXT・Markdown、または貼り付けを使ってください。${warnings.size ? ` ${[...warnings].join(' ')}` : ''}`);
  return { title: resolveDocumentTitle(title), format, rawText: raw, blocks, warnings: [...warnings] };
}
