import { ActionIcon, Menu, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';

export function ThemeControl() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const dark = useComputedColorScheme('light') === 'dark';
  return <Menu position="bottom-end" withinPortal>
    <Menu.Target>
      <ActionIcon className="theme-control" variant="subtle" size={44} aria-label="配色を変更" title="配色を変更">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {dark ? <path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z" /> : <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>}
        </svg>
      </ActionIcon>
    </Menu.Target>
    <Menu.Dropdown>
      <Menu.Label>サイト全体の配色</Menu.Label>
      {([['light', 'ライト'], ['dark', 'ダーク'], ['auto', '端末に合わせる']] as const).map(([value, label]) =>
        <Menu.Item key={value} onClick={() => setColorScheme(value)} rightSection={colorScheme === value ? <span aria-hidden="true">✓</span> : null} aria-label={`${label}${colorScheme === value ? '（選択中）' : ''}`}>{label}</Menu.Item>)}
    </Menu.Dropdown>
  </Menu>;
}
