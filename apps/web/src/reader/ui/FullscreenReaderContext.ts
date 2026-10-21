import { createContext } from 'react';

export const FullscreenReaderContext = createContext<{ desktop: boolean; setOverlayOpen: (open: boolean) => void }>({ desktop: false, setOverlayOpen: () => {} });
