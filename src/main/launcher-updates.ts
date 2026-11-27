import type { HostUpdateAnswer } from '../core/protocol-version.js';
import type { LauncherAnswer } from './launcher-control.js';
import type { UpdaterPort } from './updater.js';

/**
 * THE HOST'S UPDATES FROM ITS LAUNCHER (Tynn #1058 L6). Skeleton: the red tests' first run (test/launcher-updates-l6.test.ts).
 */
export type LauncherCall = (method: string, args?: readonly unknown[]) => Promise<LauncherAnswer>;

export function launcherUpdaterPort(_call: LauncherCall, _ownPid: number): UpdaterPort {
    return {
        configure: () => {},
        check: async () => null,
        download: async () => {},
        quitAndInstall: () => {},
    };
}

export interface UpdatesCalls {
    call(method: string, args: readonly unknown[], caller: { window: boolean; launcher?: boolean }): Promise<unknown>;
}

export function launcherHostUpdate(_service: UpdatesCalls, hostName: string): (who: { label: string; connectionId: string }) => Promise<HostUpdateAnswer> {
    return async () => ({ started: false, stub: true, reason: `${hostName}: not built yet` });
}
