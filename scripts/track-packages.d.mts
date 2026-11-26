/** Packages per track (scripts/track-packages.mjs, Tynn #1058 L3). */
export type Track = 'client' | 'browser' | 'host' | 'launcher';
export type Platform = 'win32' | 'linux';
export const COMPONENT_TRACKS: string[];
export const HOST_ENTRY: string;
export function programName(track: Track, platform: Platform): string;
export function hostRuntimeFiles(platform: Platform): string[];
export function clientBuilderConfig(base: Record<string, unknown>): Record<string, unknown>;
export function launcherInstallerConfig(base: Record<string, unknown>, options: { version: string }): Record<string, unknown>;
export function layoutWindowApp(options: { from: string; out: string; track: 'client' | 'browser'; platform: Platform }): Promise<{ files: number }>;
export function layoutHost(options: { unpackedApp: string; asarDir: string; dist: string; runtimeDir: string; out: string; platform: Platform; arch?: string }): Promise<{ files: number; leftOut: { file: string; why: string }[] }>;
export function trackTreeProblems(options: { track: Track; platform: Platform; arch?: string; files: readonly string[]; asarFiles?: readonly string[] }): { file: string; why: string }[];
export function treeOf(root: string): Promise<string[]>;
