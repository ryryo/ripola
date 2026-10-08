export const MAX_ASSET_BYTES: number;
export const DEFAULT_MAX_FILES: number;
export function contentHash(bytes: string | Uint8Array): string;
export function isInside(root: string, path: string): boolean;
export function readLibraryFile(root: string, parts: string[]): Promise<Buffer>;
export function auditText(text: string, label: string, scanLocalCode?: boolean): void;
export function validatePublicPresentation(manifest: unknown): Promise<void>;
export function validatePublicMediaMetadata(chunk: unknown): void;
export interface DistributionAudit { audioBooks: number; fileCount: number; totalBytes: number; files: Array<{ path: string; bytes: number }> }
export function auditDistribution(directory: string, options?: { maxFiles?: number; audience?: 'demo' | 'personal' }): Promise<DistributionAudit>;
