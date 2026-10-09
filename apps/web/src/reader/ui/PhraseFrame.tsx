import type { ReactNode, Ref } from 'react';

/** Both reading modes reserve separate space for guides, body text and ruby. */
export function PhraseFrame({ children, containerRef, vertical = false }: { children: ReactNode; containerRef?: Ref<HTMLDivElement>; vertical?: boolean }) {
  return <div className={`phrase-container ${vertical ? 'vertical-phrase-frame' : ''}`} ref={containerRef}><div className="guide guide-top" aria-hidden="true" />{children}<div className="guide guide-bottom" aria-hidden="true" /></div>;
}
