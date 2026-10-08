export function shortcutBlocked(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return true;
  const target = event.target;
  if (target instanceof HTMLElement && target.closest('input, textarea, select, button, a, summary, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="combobox"], [role="dialog"], [data-reader-shortcuts="off"]')) return true;
  return Boolean(document.querySelector('[role="dialog"]'));
}

export function repeatedArrowAllowed(event: KeyboardEvent, last: { current: number }): boolean {
  const now = performance.now();
  if (event.repeat && now - last.current < 90) return false;
  last.current = now;
  return true;
}
