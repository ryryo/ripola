import type { ReactNode, Ref } from 'react';
import './phrase-frame.css';

/** Both reading modes reserve separate space for guides, body text and ruby. */
export function PhraseFrame({ children, containerRef, vertical = false, expanded = false }: { children: ReactNode; containerRef?: Ref<HTMLDivElement>; vertical?: boolean; expanded?: boolean }) {
  return <div className={`phrase-container ${vertical ? 'vertical-phrase-frame' : ''}`} ref={containerRef}><div className="guide guide-top" aria-hidden="true" /><div className="phrase-slot" data-expanded={expanded}>{children}</div><div className="guide guide-bottom" aria-hidden="true" /></div>;
}
