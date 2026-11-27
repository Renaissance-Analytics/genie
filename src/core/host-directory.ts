import { remoteFromSearch } from './remote-window.js';

/**
 * THE HOST DIRECTORY (Tynn #1058 L4): what a client shows when there is no host for it to link to. A client never starts or
 * replaces a host (only the launcher does); it links to the host the launcher gives it, or it lists the hosts it knows.
 *
 * - The LOCAL host, in the `both` profile, is one row among the hosts, not special: stopped (Start = `launcher.ensureHost`),
 *   one that could not start (its reason, Open log), or one of an engine protocol this client does not speak (never
 *   replaced; it is updated).
 * - PAIRED hosts: the addresses this computer has paired with (`<runtime>/device-hosts.json`: addresses, never a token).
 *   Opening one from a client with no local host needs the client's own sign-in and token store (step 4 of the split), so
 *   until then the row says so instead of offering a button that cannot work.
 * - Tynn's own list joins once the client has its own Tynn sign-in (step 4).
 *
 * Pure: the window draws what this returns (renderer/components/HostDirectoryScreen.tsx).
 */
export const HOST_DIRECTORY_EMPTY = 'No host on this computer. Pick a host, or add one.';

export type InstallProfile = 'both' | 'client';

export type LocalHostState =
    | { readonly kind: 'none' }
    | { readonly kind: 'stopped'; readonly build: string | null }
    /** Started by the directory's Start: said on its row while its window opens. */
    | { readonly kind: 'running'; readonly build: string | null }
    | { readonly kind: 'failed'; readonly reason: string }
    | { readonly kind: 'incompatible'; readonly protocol: number; readonly mine: number };

export interface HostDirectoryInput {
    readonly profile: InstallProfile;
    readonly local: LocalHostState;
    /** The addresses this computer paired with, in the order paired. */
    readonly paired: readonly string[];
    /** Whether the launcher answers on its control wire (Start needs it). */
    readonly launcher: boolean;
}

export type HostAction = { readonly kind: 'start'; readonly label: 'Start' } | { readonly kind: 'open-log'; readonly label: 'Open log' };

export interface HostRow {
    /** `local`, or the paired host's address. */
    readonly id: string;
    readonly local: boolean;
    readonly name: string;
    readonly address: string | null;
    readonly state: 'running' | 'stopped' | 'failed' | 'incompatible' | 'paired';
    /** The status dot: green running, amber stopped or needing an update, red could not start, grey not known. */
    readonly dot: 'green' | 'amber' | 'red' | 'grey';
    /** What it is, as an icon: this computer, a host at an address, a Tynn relay host. */
    readonly icon: 'monitor' | 'server' | 'cloud';
    /** One short line. */
    readonly detail: string;
    /** The rest, for an info tooltip; `null` when the line says it all. */
    readonly more: string | null;
    readonly action: HostAction | null;
}

export interface HostDirectoryView {
    readonly title: string;
    /** The empty state's words, or `null` when there is a host to list. */
    readonly empty: string | null;
    readonly hosts: readonly HostRow[];
    readonly add: { readonly label: 'Add a host'; readonly detail: string };
}

const STEP4_LINE = 'Open from a computer with a host until sign-in arrives';
const STEP4_MORE = 'Opening another computer’s host from here needs this computer’s own Genie sign-in, which is coming. Until then, open it from a computer that has a host of its own.';

function localRow(local: LocalHostState, launcher: boolean): HostRow | null {
    const base = { id: 'local', local: true, name: 'This computer', address: null, icon: 'monitor', more: null } as const;
    switch (local.kind) {
        case 'none':
            return null;
        case 'running':
            return { ...base, state: 'running', dot: 'green', detail: local.build ? `Genie’s host ${local.build} is running. Opening it…` : 'Genie’s host is running. Opening it…', action: null };
        case 'stopped':
            return launcher
                ? { ...base, state: 'stopped', dot: 'amber', detail: local.build ? `Genie’s host ${local.build} is stopped.` : 'Genie’s host is stopped.', action: { kind: 'start', label: 'Start' } }
                : { ...base, state: 'stopped', dot: 'amber', detail: 'Genie’s host is stopped, and Genie’s launcher is not running to start it. Open Genie from its Start menu entry or desktop entry.', action: null };
        case 'failed':
            return { ...base, state: 'failed', dot: 'red', detail: local.reason, action: { kind: 'open-log', label: 'Open log' } };
        case 'incompatible':
            return { ...base, state: 'incompatible', dot: 'amber', detail: `This computer’s host speaks engine protocol ${local.protocol} and this Genie speaks ${local.mine}. Update Genie to use it.`, action: null };
    }
}

/** A host's name from its address: the host part, never the scheme, port or path. */
function nameOf(address: string): string {
    const relay = /^relay:(.+)$/.exec(address);
    if (relay) return relay[1]!;
    try { return new URL(address).hostname || address; } catch { return address; }
}

export function hostDirectory(input: HostDirectoryInput): HostDirectoryView {
    const hosts: HostRow[] = [];
    // A client profile has no host folder: a host.json another install left is not this computer's host.
    const local = input.profile === 'client' ? null : localRow(input.local, input.launcher);
    if (local) hosts.push(local);
    const seen = new Set<string>();
    for (const address of input.paired) {
        // Only what a host window would take (ws://, wss://, relay:<id>); each once.
        if (remoteFromSearch(`?${new URLSearchParams({ remote: address }).toString()}`) !== address || seen.has(address)) continue;
        seen.add(address);
        hosts.push({ id: address, local: false, name: nameOf(address), address, state: 'paired', dot: 'grey', icon: address.startsWith('relay:') ? 'cloud' : 'server', detail: STEP4_LINE, more: STEP4_MORE, action: null });
    }
    return {
        title: 'Hosts',
        empty: hosts.length === 0 ? HOST_DIRECTORY_EMPTY : null,
        hosts,
        add: { label: 'Add a host', detail: 'Adding a host from here needs this computer’s own Genie sign-in, which is coming.' },
    };
}
