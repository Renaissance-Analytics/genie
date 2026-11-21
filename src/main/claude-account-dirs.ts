/** RED stub (Tynn #1011). */
export const SHARED_SESSION_FOLDERS: readonly string[] = [];
export interface SessionLinkFs {
    mkdir(path: string): void;
    lstat(path: string): { isSymbolicLink(): boolean } | null;
    readlink(path: string): string;
    symlink(target: string, path: string, type: 'junction' | 'dir'): void;
}
export function linkSharedSessions(_configDir: string, _store: string, _options: { fs?: SessionLinkFs; platform?: NodeJS.Platform } = {}): { ok: true } | { ok: false; reason: string } {
    return { ok: false, reason: 'stub' };
}
