import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE_PROTOCOL, parseHostRecord } from '../core/engine-protocol.js';
import { hostDirectory, type HostDirectoryInput, type HostDirectoryView, type InstallProfile, type LocalHostState } from '../core/host-directory.js';
import type { LauncherAnswer } from './launcher-control.js';

/**
 * THE HOST DIRECTORY'S WINDOW SIDE (Tynn #1058 L4): what the directory window shows and does, behind ports so it is tested
 * with no window. main.ts opens the window (host-directory.html, its preload) when the client has no host to link to, and
 * waits on `untilLinked()`: Start asks the launcher for the host (`launcher.ensureHost`), and once it answers the window
 * links to it. The window never starts a host itself.
 */
export type HostDirectoryAction = 'start' | 'open-log' | 'add-host';

export interface HostDirectoryState {
    readonly view: HostDirectoryView;
    /** The row whose action runs (`local`), or `null`. */
    readonly busy: string | null;
    /** What the last action came to, in words; `null` before any. */
    readonly notice: { readonly ok: boolean; readonly text: string } | null;
}

export interface HostDirectoryPorts {
    /** What is true now: the profile, the local host, the paired hosts, whether the launcher answers. */
    readonly input: () => HostDirectoryInput;
    readonly ensureHost: () => Promise<LauncherAnswer>;
    /** Opens the host's log; the OS's words when it could not. */
    readonly openLog: () => Promise<string | null>;
    readonly push: (state: HostDirectoryState) => void;
}

export class HostDirectory {
    private busy: string | null = null;
    private notice: HostDirectoryState['notice'] = null;
    private failure: string | null = null;
    private readonly linked: Promise<void>;
    private resolveLinked: () => void = () => {};

    constructor(private readonly ports: HostDirectoryPorts) {
        this.linked = new Promise<void>((resolve) => { this.resolveLinked = resolve; });
    }

    current(): HostDirectoryState {
        const input = this.ports.input();
        // A Start that failed is this host's state until the next look says otherwise.
        const local: LocalHostState = this.failure !== null && input.local.kind === 'stopped' ? { kind: 'failed', reason: this.failure } : input.local;
        return { view: hostDirectory({ ...input, local }), busy: this.busy, notice: this.notice };
    }

    /** Resolved when the launcher has started (or found) the host: main.ts links to it then. */
    untilLinked(): Promise<void> {
        return this.linked;
    }

    async act(action: HostDirectoryAction): Promise<void> {
        if (this.busy !== null) return;
        if (action === 'add-host') { this.say({ ok: false, text: this.current().view.add.detail }); return; }
        this.busy = 'local';
        this.push();
        try {
            if (action === 'open-log') {
                const failed = await this.ports.openLog();
                this.notice = failed ? { ok: false, text: `The log could not be opened: ${failed}` } : null;
                return;
            }
            const answer = await this.ports.ensureHost();
            if (answer.ok) { this.failure = null; this.notice = { ok: true, text: 'Genie’s host is running. Opening it…' }; this.resolveLinked(); }
            else { this.failure = answer.reason; this.notice = { ok: false, text: answer.reason }; }
        } finally {
            this.busy = null;
            this.push();
        }
    }

    private say(notice: { ok: boolean; text: string }): void {
        this.notice = notice;
        this.push();
    }

    private push(): void {
        this.ports.push(this.current());
    }
}

/** The addresses this computer paired with: `<runtime>/device-hosts.json` (main/device-tokens.ts), addresses only. */
export function readPairedHosts(runtimeDir: string, read: (file: string) => string | null = readOrNull): string[] {
    try {
        const parsed = JSON.parse(read(join(runtimeDir, 'device-hosts.json')) ?? 'null') as { hosts?: unknown } | null;
        return Array.isArray(parsed?.hosts) ? parsed.hosts.filter((h): h is string => typeof h === 'string') : [];
    } catch {
        return [];
    }
}

/**
 * The local host as the directory shows it. A launched client: the launcher named a host build (`both`) or none
 * (`client`); a live host.json of another engine protocol is `incompatible`, never replaced. A process no launcher started
 * (the single-app install) came here only because its own start failed: that reason.
 */
export function localHostState(input: {
    readonly launchedHostBuild: string | null | undefined;
    readonly legacyFailure: string | null;
    readonly runtimeDir: string;
    readonly alive: (pid: number) => boolean;
    readonly read?: (file: string) => string | null;
}): { profile: InstallProfile; local: LocalHostState } {
    const record = parseHostRecord((input.read ?? readOrNull)(join(input.runtimeDir, 'host.json')));
    const profile: InstallProfile = input.launchedHostBuild === null ? 'client' : 'both';
    if (record !== null && input.alive(record.pid) && record.protocol !== ENGINE_PROTOCOL) return { profile, local: { kind: 'incompatible', protocol: record.protocol, mine: ENGINE_PROTOCOL } };
    if (input.launchedHostBuild === undefined) return { profile, local: { kind: 'failed', reason: input.legacyFailure ?? 'Genie’s host could not be started.' } };
    if (input.launchedHostBuild === null) return { profile, local: { kind: 'none' } };
    return { profile, local: { kind: 'stopped', build: input.launchedHostBuild } };
}

function readOrNull(file: string): string | null {
    try { return readFileSync(file, 'utf8'); } catch { return null; }
}
