import type { MouseEvent } from 'react';
import type { BookNavigation } from '../book-navigation';
import './book-navigation.css';

function plainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function BookNavigationBar({ previous, next, shelfHref, onNavigate }: BookNavigation & { onNavigate?: () => void }) {
  // Keep these as real links: modified clicks, new tabs, direct URLs and
  // browser history must keep working. Only a normal in-page click pauses the
  // old book, and the next reader restores its own saved position.
  const activate = (event: MouseEvent<HTMLAnchorElement>) => { if (plainClick(event)) onNavigate?.(); };
  return <nav className="book-navigation" aria-label="本棚の前後の本">
    <div className="book-navigation-inner">
      {previous
        ? <a className="book-navigation-side book-navigation-previous" href={previous.href} title={previous.title} aria-label={`前の本: ${previous.title}`} onClick={activate}>
          <Chevron direction="left" />
          <span className="book-navigation-copy"><span className="book-navigation-label">前の本</span><span className="book-navigation-title">{previous.title}</span></span>
        </a>
        : <div className="book-navigation-side book-navigation-previous is-disabled" aria-disabled="true">
          <Chevron direction="left" />
          <span className="book-navigation-copy"><span className="book-navigation-label">前の本</span><span className="book-navigation-title">先頭の本です</span></span>
        </div>}
      <div className="book-navigation-center">
        <a className="book-navigation-shelf" href={shelfHref} onClick={activate}>本棚へ戻る</a>
      </div>
      {next
        ? <a className="book-navigation-side book-navigation-next" href={next.href} title={next.title} aria-label={`次の本: ${next.title}`} onClick={activate}>
          <span className="book-navigation-copy"><span className="book-navigation-label">次の本</span><span className="book-navigation-title">{next.title}</span></span>
          <Chevron direction="right" />
        </a>
        : <div className="book-navigation-side book-navigation-next is-disabled" aria-disabled="true">
          <span className="book-navigation-copy"><span className="book-navigation-label">次の本</span><span className="book-navigation-title">最後の本です</span></span>
          <Chevron direction="right" />
        </div>}
    </div>
  </nav>;
}

function Chevron({ direction }: { direction: 'left' | 'right' }) {
  return <svg className="book-navigation-chevron" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={direction === 'left' ? 'M15 5 8 12l7 7' : 'm9 5 7 7-7 7'} />
  </svg>;
}
