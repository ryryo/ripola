import type { Page } from '@playwright/test';

/** Inspect visible words and geometry; animated gauge attributes are intentionally allowed. */
export async function inspectCalmPlayback(page: Page, durationMs = 2200) {
  return page.evaluate(duration => new Promise<{ changedOutsideBody: boolean; bodyChanges: number; progressIncreases: number; maxLayoutShift: number }>(resolve => {
    const words = () => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const values: string[] = [];
      while (walker.nextNode()) {
        const node = walker.currentNode; const parent = node.parentElement; if (!parent || !node.textContent?.trim()) continue;
        if (parent.closest('.audio-sentence, .phrase-container, .visually-hidden')) continue;
        // Layout queries can materialize descendants of a closed details panel;
        // only its direct summary is actually visible to the reader.
        let closed = parent.closest('details:not([open])'); let hidden = false;
        while (closed) {
          const summary = [...closed.children].find(node => node.tagName === 'SUMMARY');
          if (!summary?.contains(parent)) { hidden = true; break; }
          closed = closed.parentElement?.closest('details:not([open])') ?? null;
        }
        if (hidden) continue;
        const style = getComputedStyle(parent);
        if (!parent.getClientRects().length || style.visibility === 'hidden' || style.display === 'none') continue;
        values.push(node.textContent.trim());
      }
      return values.join('\u001f');
    };
    const geometry = () => ['.audio-stage', '.reader-stage', '.audio-progress', '.reading-progress', '.audio-controls', '.reader-controls'].flatMap(selector => {
      const node = document.querySelector(selector); if (!node) return []; const box = node.getBoundingClientRect(); return [box.top, box.height];
    });
    const phrase = () => document.querySelector('[data-testid="audio-phrase"], [data-testid="current-phrase"]')?.textContent ?? '';
    const progress = () => Number((document.querySelector('.reading-track') as HTMLElement)?.dataset.progress ?? (document.querySelector('#audio-position') as HTMLInputElement)?.value ?? 0);
    const initial = words(); const boxes = geometry(); const start = performance.now(); let lastPhrase = phrase(); let lastProgress = progress();
    let changedOutsideBody = false; let bodyChanges = 0; let progressIncreases = 0; let maxLayoutShift = 0;
    const sample = () => {
      changedOutsideBody ||= words() !== initial;
      const current = phrase(); if (current !== lastPhrase) { bodyChanges++; lastPhrase = current; }
      const distance = progress(); if (distance > lastProgress) progressIncreases++; lastProgress = distance;
      maxLayoutShift = Math.max(maxLayoutShift, ...geometry().map((value, index) => Math.abs(value - boxes[index])));
      if (performance.now() - start < duration) requestAnimationFrame(sample);
      else resolve({ changedOutsideBody, bodyChanges, progressIncreases, maxLayoutShift });
    };
    requestAnimationFrame(() => requestAnimationFrame(sample));
  }), durationMs);
}
