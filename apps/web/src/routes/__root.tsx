import { createRootRoute, HeadContent, Outlet, Scripts, useHydrated } from '@tanstack/react-router';
import { ColorSchemeScript, localStorageColorSchemeManager, mantineHtmlProps, MantineProvider } from '@mantine/core';
import mantineStyles from '@mantine/core/styles.css?url';
import styles from '../styles.css?url';
import { ripolaCssVariables, ripolaTheme } from '../theme';
import { COLOR_SCHEME_KEY, COLOR_SCHEME_MIGRATION_SCRIPT } from '../ui/color-scheme';

const colorSchemeManager = localStorageColorSchemeManager({ key: COLOR_SCHEME_KEY });
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      { title: 'Ripola — ひとつずつ、一定のペースで。' },
      { name: 'description', content: '日本語をフレーズずつ読む、端末内で動くリーダー。' },
      { name: 'robots', content: import.meta.env.VITE_RSVP_PROFILE === 'pages' ? 'index, follow' : 'noindex, nofollow' },
    ],
    links: [{ rel: 'stylesheet', href: mantineStyles }, { rel: 'stylesheet', href: styles }],
  }),
  component: Root,
  notFoundComponent: () => <main><h1>ページが見つかりません</h1><a href={import.meta.env.BASE_URL}>リーダーへ戻る</a></main>,
});
function Root() {
  const hydrated = useHydrated();
  return <html lang="ja" {...mantineHtmlProps}><head><HeadContent /><script dangerouslySetInnerHTML={{ __html: COLOR_SCHEME_MIGRATION_SCRIPT }} /><ColorSchemeScript defaultColorScheme="auto" localStorageKey={COLOR_SCHEME_KEY} /></head><body>
    <MantineProvider theme={ripolaTheme} cssVariablesResolver={ripolaCssVariables} colorSchemeManager={colorSchemeManager} defaultColorScheme="auto">{hydrated ? <Outlet /> : <main className="boot">リーダーを準備しています…</main>}</MantineProvider>
    <Scripts />
  </body></html>;
}
