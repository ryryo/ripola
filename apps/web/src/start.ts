import { createCsrfMiddleware, createMiddleware, createStart } from '@tanstack/react-start';
import { assertLocalRequest } from './server/local-request';
import { localGenerationOrigin } from './server/local-origin.server';

const localBoundary = createMiddleware().server(async ({ request, handlerType, next }) => {
  if (handlerType === 'serverFn' || new URL(request.url).pathname.startsWith('/api/local-')) {
    if (import.meta.env.VITE_RSVP_PROFILE !== 'local') return new Response('Not found', { status: 404 });
    try { assertLocalRequest(request, await localGenerationOrigin()); }
    catch { return new Response('Forbidden', { status: 403 }); }
  }
  return next();
});
export const startInstance = createStart(() => ({
  requestMiddleware: [localBoundary, createCsrfMiddleware({ filter: ctx => ctx.handlerType === 'serverFn' })],
}));
