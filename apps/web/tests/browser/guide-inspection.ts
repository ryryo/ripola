import type { Page } from '@playwright/test';

/** Measure glyph ranges, including ruby, rather than only the body line box. */
export async function inspectGuides(page: Page, selector: string, duration = 0) {
  return page.evaluate(({ selector, duration }) => new Promise<{ samples: number; overlap: boolean; minimumGap: number; guides: number; ruby: number }>(resolve => {
    const started = performance.now();
    let samples = 0; let overlap = false; let minimumGap = Infinity; let guides = 0; let ruby = 0;
    const sample = () => {
      const stage = document.querySelector(selector)!;
      const body = stage.querySelector('[data-testid="current-phrase"], [data-testid="audio-sentence"]')!;
      const rects: DOMRect[] = [];
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent?.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(walker.currentNode);
        rects.push(...range.getClientRects());
      }
      const markers = [...stage.querySelectorAll<HTMLElement>('.guide')].filter(node => Number(getComputedStyle(node).opacity) > 0);
      guides = markers.length; ruby = body.querySelectorAll('rt').length;
      for (const marker of markers) {
        const guide = marker.getBoundingClientRect();
        for (const text of rects) {
          if (guide.left < text.right && guide.right > text.left && guide.top < text.bottom && guide.bottom > text.top) overlap = true;
          minimumGap = Math.min(minimumGap, marker.classList.contains('guide-top') ? text.top - guide.bottom : guide.top - text.bottom);
        }
      }
      samples++;
      if (performance.now() - started < duration) requestAnimationFrame(sample);
      else resolve({ samples, overlap, minimumGap, guides, ruby });
    };
    sample();
  }), { selector, duration });
}
