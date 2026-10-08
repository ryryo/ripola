import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
const profile = process.env.VITE_RSVP_PROFILE ?? 'local';
if (!['local', 'pages', 'worker'].includes(profile)) throw new Error('Unknown RSVP build profile');
const local = profile === 'local';
const tree = local ? 'routeTree.gen.ts' : `routeTree.${profile}.gen.ts`;
export default defineConfig({
  base: profile === 'pages' ? '/ripola/' : '/',
  define: { 'import.meta.env.VITE_RSVP_PROFILE': JSON.stringify(profile) },
  // The browser entry uses document.createElement; Workers need the pure entity table.
  resolve: { alias: [
    { find: 'decode-named-character-reference', replacement: fileURLToPath(new URL('./node_modules/decode-named-character-reference/index.js', import.meta.url)) },
    { find: /^\.\/routeTree\.gen$/, replacement: fileURLToPath(new URL(`./src/${tree}`, import.meta.url)) },
  ] },
  plugins: [tanstackStart({
    spa: { enabled: true },
    start: { entry: local ? 'start.ts' : 'start.public.ts' },
    router: {
      generatedRouteTree: tree,
      routeFileIgnorePattern: local ? undefined : profile === 'pages' ? '(generate|library|books)\\.tsx$|api\\.local' : '(generate|library|demo)\\.tsx$|api\\.local',
    },
    importProtection: { behavior: 'error', client: { files: ['**/generation/core/**', '**/server/**'] } },
  }), react()],
  ssr: { external: ['wrangler'] },
  optimizeDeps: { include: ['budoux', 'decode-named-character-reference', 'unified', 'remark-parse', 'remark-gfm', 'remark-frontmatter'] },
  server: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: { outDir: local ? 'dist' : `dist/${profile}`, license: { fileName: 'THIRD-PARTY-LICENSES.md' } },
});
