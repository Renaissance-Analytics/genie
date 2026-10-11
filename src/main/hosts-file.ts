import { hostsFileBlock, mergeHostsFile, type GenRoute } from '../core/gen-router.js';

/**
 * THE HOSTS FILE — the Genie-owned block that makes `<name>.gen` resolve to loopback for external
 * browsers. Written only when the block actually CHANGES (no elevation prompt for no change), plainly
 * when the process may, with elevation only on EACCES, and a declined elevation is reported with the
 * block the person could paste themselves — never retried into a prompt loop.
 */

export interface HostsIo {
    read(): Promise<string>;
    write(content: string): Promise<void>;
    /** Through the OS's elevation prompt (UAC / sudo / osascript); the adapter decides how. */
    writeElevated(content: string): Promise<void>;
}

export type HostsSyncResult =
    | { changed: false; elevated: false }
    | { changed: true; elevated: boolean }
    | { changed: false; elevated: false; error: string; manualBlock: string };

export async function syncHostsFile(routes: readonly GenRoute[], io: HostsIo): Promise<HostsSyncResult> {
    const current = await io.read();
    const next = mergeHostsFile(current, routes);
    if (next === current) return { changed: false, elevated: false };
    try {
        await io.write(next);
        return { changed: true, elevated: false };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EACCES' && (error as NodeJS.ErrnoException).code !== 'EPERM') {
            return { changed: false, elevated: false, error: (error as Error).message, manualBlock: hostsFileBlock(routes) };
        }
    }
    try {
        await io.writeElevated(next);
        return { changed: true, elevated: true };
    } catch (error) {
        return { changed: false, elevated: false, error: (error as Error).message, manualBlock: hostsFileBlock(routes) };
    }
}
