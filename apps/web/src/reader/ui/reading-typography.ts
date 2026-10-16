import type { ReadingUnit } from '../model';
import { uprightRuns } from '../vertical-typography';

export function appendTypography(parent: Node, text: string, vertical: boolean) {
  let offset = 0;
  for (const run of vertical ? uprightRuns(text) : []) {
    parent.appendChild(document.createTextNode(text.slice(offset, run.start)));
    const span = document.createElement('span');
    span.className = run.combined ? 'reading-combined' : 'reading-upright';
    span.textContent = text.slice(run.start, run.end); parent.appendChild(span); offset = run.end;
  }
  parent.appendChild(document.createTextNode(text.slice(offset)));
}

/** Measurement must use the same ruby and upright inline boxes as the visible text. */
export function appendReadingText(parent: HTMLElement, unit: Pick<ReadingUnit, 'text' | 'ruby'>, ruby: boolean, vertical: boolean) {
  parent.replaceChildren();
  let offset = 0;
  for (const span of ruby ? unit.ruby : []) {
    appendTypography(parent, unit.text.slice(offset, span.start), vertical);
    const base = document.createElement('ruby');
    appendTypography(base, unit.text.slice(span.start, span.end), vertical);
    const rt = document.createElement('rt'); rt.textContent = span.reading; base.append(rt); parent.append(base); offset = span.end;
  }
  appendTypography(parent, unit.text.slice(offset), vertical);
}
