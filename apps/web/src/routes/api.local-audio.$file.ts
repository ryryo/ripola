import { createFileRoute } from '@tanstack/react-router';
import { readLocalAudio } from '../server/audio-route.server';
export const Route = createFileRoute('/api/local-audio/$file')({
  server: { handlers: {
    GET: ({ request, params }) => readLocalAudio(request, params.file),
    HEAD: ({ request, params }) => readLocalAudio(request, params.file),
  } },
});
