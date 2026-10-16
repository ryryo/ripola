import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useRouter } from '@tanstack/react-router';
import type { ReadingDocument } from '../reader/model';
import type { InputFormat } from '../reader/input-format';

declare module '@tanstack/react-router' {
  interface HistoryState { ripolaFrom?: string }
}

export interface ReadingDraft {
  title: string; text: string; format: InputFormat; audioEnabled: boolean;
  document?: ReadingDocument; pdfData?: ArrayBuffer;
}
export interface ReadingSession {
  draft: ReadingDraft;
  reading?: { document: ReadingDocument; pdfData?: ArrayBuffer; index: number; sourceOpen?: boolean };
}
interface SessionStore { sessions: Map<string, ReadingSession>; draft?: ReadingDraft }
interface NavigationLocation { searchStr: string; state: { __TSR_key?: string } }
function sessionKey(location: NavigationLocation) {
  return new URLSearchParams(location.searchStr).get('reading') ?? location.state.__TSR_key ?? 'initial';
}
const NavigationContext = createContext<{
  search: URLSearchParams; entryKey: string; store: SessionStore;
  go: (href: string, replace?: boolean) => Promise<void>; backTo: (href: string) => void;
} | null>(null);

export function AppNavigationProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const location = useLocation();
  const [store] = useState<SessionStore>(() => ({ sessions: new Map() }));
  const go = useCallback((href: string, replace = false) => {
    const from = window.location.pathname + window.location.search;
    return router.navigate({ href, replace, state: { ripolaFrom: from } });
  }, [router]);
  const backTo = useCallback((href: string) => {
    if (router.latestLocation.state.ripolaFrom === href) router.history.back();
    else void go(href, true);
  }, [go, router]);
  useEffect(() => {
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest('a') : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute('download') || anchor.target && anchor.target !== '_self') return;
      const url = new URL(anchor.href);
      const base = import.meta.env.BASE_URL;
      const routes = Object.values(router.routesById).filter(route => route.options.component);
      if (url.origin !== window.location.origin || !routes.some(route => url.pathname.replace(/\/$/, '') === `${base}${route.fullPath.slice(1)}`.replace(/\/$/, ''))) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return;
      event.preventDefault();
      void go(url.pathname + url.search + url.hash);
    };
    document.addEventListener('click', click);
    return () => document.removeEventListener('click', click);
  }, [go, router]);
  const value = useMemo(() => ({ search: new URLSearchParams(location.searchStr), entryKey: sessionKey(location), store, go, backTo }), [location, store, go, backTo]);
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useAppNavigation() {
  const value = useContext(NavigationContext);
  if (!value) throw new Error('App navigation requires its provider.');
  return value;
}

export function useBeforeAppNavigation(callback: (entryKey: string) => void) {
  const router = useRouter();
  const current = useRef(callback); current.current = callback;
  useLayoutEffect(() => router.subscribe('onBeforeNavigate', event => {
    if (event.fromLocation && (event.hrefChanged || sessionKey(event.fromLocation) !== sessionKey(event.toLocation))) current.current(sessionKey(event.fromLocation));
  }), [router]);
}
