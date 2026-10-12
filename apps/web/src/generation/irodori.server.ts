import '@tanstack/react-start/server-only';
import { getIrodoriController } from './core/irodori-controller';
import { getLocalGenerationService } from './service.server';

export async function localIrodoriController() {
  // Use the existing localhost/Origin/Fetch Metadata/CSRF boundary.
  await getLocalGenerationService();
  return getIrodoriController();
}
