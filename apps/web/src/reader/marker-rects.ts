export interface MarkerRect { left: number; top: number; width: number; height: number }

/** One background per continuous line fragment avoids seams and double opacity. */
export function mergeMarkerRects(rects: MarkerRect[], vertical: boolean, gap: number): MarkerRect[] {
  const cross = vertical ? 'left' : 'top';
  const crossSize = vertical ? 'width' : 'height';
  const along = vertical ? 'top' : 'left';
  const alongSize = vertical ? 'height' : 'width';
  const result: MarkerRect[] = [];
  for (const rect of [...rects].sort((a, b) => a[along] - b[along])) {
    if (rect.width <= .1 || rect.height <= .1) continue;
    const previous = result.findLast(value => Math.abs(value[cross] - rect[cross]) < .5 && Math.abs(value[crossSize] - rect[crossSize]) < .5);
    if (previous && rect[along] <= previous[along] + previous[alongSize] + gap) {
      previous[alongSize] = Math.max(previous[along] + previous[alongSize], rect[along] + rect[alongSize]) - previous[along];
    } else result.push({ ...rect });
  }
  return result;
}
