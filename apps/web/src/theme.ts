import { createTheme, type CSSVariablesResolver } from '@mantine/core';

export const ripolaTheme = createTheme({
  primaryColor: 'ripola',
  primaryShade: 7,
  colors: {
    ripola: ['#f2fbff', '#e5f4fc', '#cbeaf7', '#a3dcef', '#69c6e8', '#36b3d8', '#229bc4', '#1679b4', '#116594', '#104e74'],
    dark: ['#edf5fb', '#adbfce', '#8aa5b8', '#6d879a', '#3b5466', '#315a71', '#1d2f3d', '#14212c', '#101b24', '#0c141c'],
  },
  fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN", sans-serif',
  defaultRadius: 'md',
  radius: { md: '9px', lg: '16px' },
  headings: { fontWeight: '600' },
});

export const ripolaCssVariables: CSSVariablesResolver = () => {
  const colors = {
    '--mantine-color-body': 'var(--paper)',
    '--mantine-color-text': 'var(--ink)',
    '--mantine-color-dimmed': 'var(--muted)',
    '--mantine-color-placeholder': 'var(--muted)',
    '--mantine-color-default': 'var(--panel)',
    '--mantine-color-default-color': 'var(--ink)',
    '--mantine-color-default-border': 'var(--line)',
    '--mantine-color-default-hover': 'var(--accent-hover)',
    '--mantine-color-disabled': 'var(--line)',
    '--mantine-color-disabled-color': 'var(--muted)',
    '--mantine-color-ripola-light': 'var(--accent-soft)',
    '--mantine-color-ripola-light-hover': 'var(--accent-hover)',
    '--mantine-color-ripola-light-color': 'var(--accent-ink)',
    '--mantine-color-ripola-outline': 'var(--accent)',
    '--mantine-color-ripola-outline-hover': 'var(--accent-soft)',
  };
  return { variables: {}, light: colors, dark: colors };
};
