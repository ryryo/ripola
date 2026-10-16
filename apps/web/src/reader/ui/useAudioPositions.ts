import { useCallback, useSyncExternalStore } from 'react';
import { audioPositions } from '../audio-position-store';

export function useAudioPositions(books: readonly { id: string; revision: string }[]) {
  const subscribe = useCallback((listener: () => void) => audioPositions.subscribe(books, listener), [books]);
  return useSyncExternalStore(subscribe, audioPositions.getSnapshot, audioPositions.getServerSnapshot);
}
