export type ReaderProfile = 'local' | 'worker' | 'pages';
export function readerCapabilities(profile: string | undefined) {
  const local = profile === 'local';
  return { localGeneration: local, audioRename: local, environmentLabel: local ? 'ローカルPC版' : '配布閲覧版', audioRoute: local ? 'library' : profile === 'pages' ? 'demo/' : 'books/' } as const;
}
