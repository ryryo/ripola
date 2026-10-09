export interface BrowserCase { project: string; file: string; title: string; lane: string; domains: string[] }
export const DOMAINS: string[];
export const browserCases: BrowserCase[];
export function classifyChanges(paths: string[], options?: { manual?: boolean; uncertain?: boolean }): { code: boolean; mode: string; domains: string[]; python: boolean; reason: string };
export function selectedCases(mode?: string, domains?: string[]): BrowserCase[];
export function wrappingVariants(mode: string, viewportIndex: number, fonts: string[]): { silent: { family: string; size: number; ruby: boolean }[]; audio: { family: string; ruby: boolean }[] };
export function projectGrep(project: string, mode: string, domains: string[]): RegExp | undefined;
export function caseKey(item: BrowserCase): string;
export function assertCaseInventory(actual: BrowserCase[], expected?: BrowserCase[]): void;
export function assertBrowserFiles(files: string[]): void;
