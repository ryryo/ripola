import '@tanstack/react-start/server-only';
import { getLocalGenerationService } from '../generation/service.server';
import { audioResponse } from './audio-response';
export async function readLocalAudio(request: Request, file: string) {
  const match = /^([a-f0-9]{64})\.(wav|mp3)$/.exec(file);
  if (!match) return new Response('Not found', { status: 404 });
  try {
    const service = await getLocalGenerationService();
    const audio = await service.getAudio(match[1], match[2] as 'wav' | 'mp3');
    if (match[2] === 'wav' && audio.mimeType === 'audio/mpeg') return Response.redirect(new URL(`${match[1]}.mp3`, request.url), 307);
    return audioResponse(audio.bytes, request, audio.mimeType);
  } catch { return new Response('Audio unavailable', { status: 404 }); }
}
