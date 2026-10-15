import '@tanstack/react-start/server-only';
import { getIrodoriController } from './core/irodori-controller';
import { getLocalGenerationService } from './service.server';

export async function localIrodoriController() {
  // Use the existing localhost/Origin/Fetch Metadata/CSRF boundary.
  const service = await getLocalGenerationService();
  if (!service.config.experimentalIrodori) throw new Error('Irodoriは開発用です。RSVP_ENABLE_EXPERIMENTAL_IRODORI=trueで明示的に有効化してください。');
  return getIrodoriController();
}
