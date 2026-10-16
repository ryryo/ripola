export interface UprightRun { start: number; end: number; combined: boolean }

/** UTF-16 source ranges only: typography never rewrites manuscript or timing text. */
export function uprightRuns(text: string): UprightRun[] {
  const runs: UprightRun[] = [];
  for (const match of text.matchAll(/[0-9０-９]+|[!?！？]+/gu)) {
    if (/^[\p{Mark}\u200d]/u.test(text.slice(match.index + match[0].length))) continue;
    const punctuation = /[!?！？]/u.test(match[0]);
    if (match[0].length <= 2 || punctuation) runs.push({ start: match.index, end: match.index + match[0].length, combined: match[0].length <= 2 });
  }
  return runs;
}
