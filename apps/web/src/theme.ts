import { createTheme } from '@mantine/core';

export const ripolaTheme = createTheme({
  primaryColor: 'ripola',
  primaryShade: 7,
  colors: {
    ripola: ['#f2fbff', '#e5f4fc', '#cbeaf7', '#a3dcef', '#69c6e8', '#36b3d8', '#229bc4', '#1679b4', '#116594', '#104e74'],
  },
  fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN", sans-serif',
  defaultRadius: 'md',
  radius: { md: '9px', lg: '16px' },
  headings: { fontWeight: '600' },
});
