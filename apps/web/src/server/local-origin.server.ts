import '@tanstack/react-start/server-only';
import { loadGenerationConfig } from '../generation/core/config';
// This entry is reachable only in the local profile and returns no secret values.
let origin: Promise<string> | undefined;
export function localGenerationOrigin(): Promise<string> {
  return origin ??= loadGenerationConfig().then(config => config.localOrigin);
}
