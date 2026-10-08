import type { ReactNode, Ref } from 'react';

/** Both reading modes reserve separate space for guides, body text and ruby. */
export function PhraseFrame({ children, containerRef }: { children: ReactNode; containerRef?: Ref<HTMLDivElement> }) {
  return <div className="phrase-container" ref={containerRef}><div className="guide guide-top" aria-hidden="true" />{children}<div className="guide guide-bottom" aria-hidden="true" /></div>;
}
