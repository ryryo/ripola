import { createMiddleware, createStart } from '@tanstack/react-start';
// Public profiles have no generator entry, even in their prerender server.
const viewOnly = createMiddleware().server(async ({ request, handlerType, next }) => {
  if (handlerType === 'serverFn' || new URL(request.url).pathname.startsWith('/api/local-')) return new Response('Not found', { status: 404 });
  return next();
});
export const startInstance = createStart(() => ({ requestMiddleware: [viewOnly] }));
