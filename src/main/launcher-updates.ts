import type { HostUpdateAnswer } from '../core/protocol-version.js';
import type { UpdateScope } from '../core/update-kind.js';
import type { LauncherAnswer } from './launcher-control.js';
import type { UpdaterPort } from './updater.js';

/**
 * THE HOST'S UPDATES FROM ITS LAUNCHER (Tynn #1058 L6; the spec's "What leaves the host"). A host the launcher started
 * keeps `UpdateHost` — its state machine, its drain, its replica, so the Updates UI does not change — and gets what is on
 * offer from the launcher, which reads the feed, downloads and verifies (native/launcher/src/updates.rs). The `--updater`
 * helper is never started by such a host: it stays only in the bridge release, for the Genie that installs the bridge.
 *
 * - `check`: `launcher.check`. A ready host is a host update (it comes with its client: the launcher swaps both); with no
 *   host ready, a ready client (or browser) is client-only, and this host keeps running through it.
 * - `download`: nothing; the launcher made the build ready at its check.
 * - `prepareInstall`: the offer is still ready (`launcher.updates`), before anything is stopped.
 * - `quitAndInstall`: a host update asks `launcher.apply {track: host, afterPid}` — the launcher waits for this pid, points,
 *   starts the new host, and goes back if it does not answer — and this host then exits (UpdatesService); a client-only one
 *   asks for its track alone.
 */
export type LauncherCall = (method: string, args?: readonly unknown[]) => Promise<LauncherAnswer>;

interface Row {
    readonly track?: unknown;
    readonly state?: unknown;
    readonly offer?: { readonly build?: unknown } | null;
}

interface Offered {
    readonly track: 'host' | 'client' | 'browser';
    readonly build: string;
}

async function rows(call: LauncherCall, method: 'launcher.check' | 'launcher.updates'): Promise<Row[]> {
    const answer = await call(method, []);
    if (!answer.ok) throw new Error(answer.reason);
    const tracks = (answer.value as { tracks?: unknown } | null)?.tracks;
    return Array.isArray(tracks) ? (tracks as Row[]) : [];
}

function ready(list: readonly Row[]): Offered | null {
    for (const track of ['host', 'client', 'browser'] as const) {
        const row = list.find((r) => r.track === track && r.state === 'ready');
        const build = row?.offer?.build;
        if (typeof build === 'string' && build !== '') return { track, build };
    }
    return null;
}

export function launcherUpdaterPort(call: LauncherCall, ownPid: number): UpdaterPort {
    let offered: Offered | null = null;
    return {
        // The channel is the launcher's (state.json, `launcher.channel`); the host's own setting is told to it.
        configure: (config) => { void call('launcher.channel', [{ channel: config.allowPrerelease ? 'dev' : 'stable' }]); },
        check: async () => {
            offered = ready(await rows(call, 'launcher.check'));
            if (offered === null) return null;
            const scope: UpdateScope = offered.track === 'host'
                ? { kind: 'full', why: 'a host update (it comes with its client)' }
                : { kind: 'client-only' };
            return { version: offered.build, scope };
        },
        download: async (onProgress) => { onProgress(100); },
        prepareInstall: async () => {
            const still = ready(await rows(call, 'launcher.updates'));
            if (offered === null || still === null || still.track !== offered.track || still.build !== offered.build) {
                throw new Error('That update is no longer ready here; check for updates again');
            }
        },
        quitAndInstall: async () => {
            if (offered === null) throw new Error('There is no update to install');
            const args = offered.track === 'host' ? [{ track: 'host', afterPid: ownPid }] : [{ track: offered.track }];
            const answer = await call('launcher.apply', args);
            if (!answer.ok) throw new Error(`Genie’s launcher did not take the update: ${answer.reason}`);
        },
    };
}

export interface UpdatesCalls {
    call(method: string, args: readonly unknown[], caller: { window: boolean; launcher?: boolean }): Promise<unknown>;
}

/**
 * `host.update` from a paired owner (Tynn #894; the stub's place): the launcher's check, then this host's install through
 * its own drain, which ends in the launcher's swap. Answered as soon as the install has started; the drain takes a while.
 */
export function launcherHostUpdate(service: UpdatesCalls, hostName: string): (who: { label: string; connectionId: string }) => Promise<HostUpdateAnswer> {
    const caller = { window: false, launcher: true } as const;
    return async () => {
        let state: { phase?: unknown; version?: unknown } | null;
        try {
            state = (await service.call('check', [], caller)) as typeof state;
        } catch (error) {
            return { started: false, reason: `${hostName} could not check for updates: ${error instanceof Error ? error.message : String(error)}` };
        }
        const version = typeof state?.version === 'string' ? state.version : null;
        if ((state?.phase !== 'available' && state?.phase !== 'downloaded') || version === null) {
            return { started: false, reason: `${hostName} is up to date: there is no host update to install.` };
        }
        void service.call('install', [], caller).catch(() => undefined);
        return { started: true, reason: `${hostName} is updating to ${version}: its agents pause at a safe moment and come back after.` };
    };
}
