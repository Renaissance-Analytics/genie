/** One track's package and its manifest (scripts/pack-track.mjs, Tynn #1058 L1; format 2 since L3). */
export interface PackMeta {
    track: 'client' | 'host' | 'browser' | 'launcher';
    build: string;
    channel: 'stable' | 'dev';
    platform: 'win32' | 'linux';
    arch: 'x64' | 'arm64';
    /** A host's client build (required of a host, refused for any other track). */
    withClient?: string | undefined;
    minLauncher?: string | null;
    notes?: string;
    nextKey?: string;
}
export interface PackedManifest {
    format: 2;
    track: string;
    build: string;
    schema: string;
    channel: string;
    platform: string;
    arch: string;
    withClient?: string;
    minLauncher: string | null;
    files: Array<{ path: string; size: number; sha256: string }>;
    notes: string;
    nextKey?: string;
}
export const PACKAGE_TRACKS: string[];
export const CHANNELS: string[];
export const PLATFORMS: string[];
export const ARCHES: string[];
export const MANIFEST_FORMAT: 2;
export function schemaOfBuild(build: unknown): string | null;
export function checkManifest(m: unknown): PackedManifest;
export function manifestBytes(m: unknown): Buffer;
export function buildManifest(from: string, meta: PackMeta): Promise<PackedManifest>;
export function readArchive(path: string): Promise<Array<{ path: string; mode: number; data: Buffer }>>;
export function packTrack(options: PackMeta & { from: string; out: string }): Promise<{ base: string; archive: string; manifest: string; value: PackedManifest }>;
