import { join } from 'node:path';
import { writeJsonAtomic } from './store.js';

/**
 * THE DATA ROOT'S MANIFEST (the host split, P7.2; Tynn #418): what is in `<root>`, in two lists.
 *
 * A workstation's machine is disposable (the plan's §12.1): the host's code is installed, its secrets are in the OS
 * keychain, and everything else it holds is under one root. This file says which of that is STATE — kept, and what a
 * rebuilt machine is given back — and which is MACHINE: made again on every start from the state and the machine the
 * host finds itself on, and safe to delete. genie-host writes the two lists to `<root>/data-root.json` when it starts.
 *
 * ## A State rule also says whether it TRAVELS
 *
 * Some state is this root's alone: a login or a secret that lives in a file (a provider's own login files, the gen CA's
 * private key, the service passwords, a site's cookies), a pointer to a keychain entry, and trust, which is given per
 * machine. It is kept when the machine under the root is rebuilt, and it is never put in a bundle that goes to another
 * workstation (P8 reads `travels`). Every State rule says which, in so many words; a test refuses a rule that does not.
 *
 * ## A new store goes in a list here, or the tests fail
 *
 * test/p7-data-root-manifest.test.ts reads the paths genie-host.ts joins onto its root, every data-file name host-side
 * code names, and what a real genie-host makes in an empty root, and fails on one that `classifyDataPath` does not know.
 * So: a folder's rule ends with `/` and covers all in it; `names` are the file names code uses inside a folder rule (the
 * test needs them to know the name is accounted for); `atStart` marks what every host makes when it starts.
 */

export const DATA_ROOT_FILE = 'data-root.json';
/** The manifest's format. A reader that does not know a format reads nothing from it. */
export const DATA_ROOT_FORMAT = 1;

export interface DataRootRule {
    /** Relative to the root, `/` between folders. A trailing `/` is a folder and everything in it. */
    readonly path: string;
    readonly kind: 'state' | 'machine';
    /** What it holds, in a line. */
    readonly holds: string;
    /** State only, and always said: whether it goes with the work to another workstation. */
    readonly travels?: boolean;
    /** File names code uses inside this folder. */
    readonly names?: readonly string[];
    /** Every host makes it when it starts. */
    readonly atStart?: boolean;
}

const state = (path: string, travels: boolean, holds: string, more: Pick<DataRootRule, 'names' | 'atStart'> = {}): DataRootRule => ({ path, kind: 'state', travels, holds, ...more });
const machine = (path: string, holds: string, more: Pick<DataRootRule, 'names' | 'atStart'> = {}): DataRootRule => ({ path, kind: 'machine', holds, ...more });

export const DATA_ROOT_RULES: readonly DataRootRule[] = [
    // --- STATE: the work ---------------------------------------------------------------------------------------------
    state('runtime/workspaces.json', true, 'the registry: the workspaces'),
    state('runtime/agents.json', true, 'the registry: the agents'),
    state('runtime/sessions/', true, 'the agents’ threads, their segments and what was attached to them', { names: ['.index.json', 'attachments.json'] }),
    state('runtime/inbox/', true, 'the agents’ mail and its attachments', { names: ['mail.json'] }),
    state('runtime/attention.json', true, 'the questions, lists and handoffs that wait for the person'),
    state('runtime/attention-history.json', true, 'the finished ones'),
    state('runtime/attention-archive.jsonl', true, 'the finished ones, archived'),
    state('runtime/knowledge.db', true, 'the knowledge store', { atStart: true }),
    state('runtime/settings.json', true, 'the person’s settings'),
    state('runtime/chat-drafts.json', true, 'unsent chat drafts'),
    state('runtime/chat-drafts/', true, 'the files of unsent chat drafts'),
    state('runtime/flows.json', true, 'the flows and their runs'),
    state('runtime/processes.json', true, 'the processes the person keeps'),
    state('runtime/running-at-quit.json', true, 'the agents that were working when Genie last stopped'),
    state('runtime/interrupted-at-quit.json', true, 'the agents whose turn the last stop cut short'),
    // What the person stopped stays stopped: a rebuilt machine must not start it (ruled 2026-11-23).
    state('runtime/engine-run-state.json', true, 'the service engines the person stopped'),
    state('runtime/site-run-state.json', true, 'the sites the person stopped'),
    state('plugins/', true, 'the installed plugins and whether each is on', { names: ['plugins-state.json', 'plugins-network.json'] }),
    state('gapps/', true, 'the installed GApps, what each was granted and what each stored', { names: ['book.json', 'previews.json'] }),
    state('marketplace-grants.json', true, 'what the person granted to plugins'),
    state('proof-of-done-notes.json', true, 'the proof-of-done notes still owed to a repository'),
    state('osa/', true, 'the Genie OSA’s home: its instructions, and what it kept'),

    // --- STATE that is this root's alone: logins, secrets in files, pointers to the keychain, trust ---------------------
    state(DATA_ROOT_FILE, false, 'this manifest', { atStart: true }),
    state('workstation.json', false, 'which workstation this is to Tynn; its key is in the keychain'),
    state('credentials/', false, 'who is signed in to Tynn; the credential is in the keychain', { names: ['tynn.json'] }),
    state('github.json', false, 'who is signed in to GitHub; the tokens are in the keychain'),
    state('agent-credentials/', false, 'the agents’ Tynn identities; their keys are in the keychain'),
    state('runtime/device-hosts.json', false, 'the machines this one is paired with; the tokens are in the keychain'),
    state('keychain-migration.json', false, 'which secrets an older Genie’s files were moved from'),
    state('runtime/remote-devices.json', false, 'the devices paired with this machine, by the hash of their token'),
    state('runtime/app-inbox.json', false, 'the app inbox’s script keys, by their hash'),
    state('runtime/mail-inboxes.json', false, 'the mail inboxes, with the hash of each password'),
    state('runtime/services.json', false, 'the service engines and each workspace’s databases, with their passwords'),
    state('runtime/gen-ca/', false, 'the .gen certificate authority, with its private key', { names: ['ca.crt', 'ca.key', 'leaf.crt', 'leaf.key', 'adopted.json', 'trust-prompt.json'] }),
    state('runtime/workspace-trust.json', false, 'which workspaces the person trusted, on this machine'),
    state('runtime/accounts.json', false, 'the provider accounts and which is active', { atStart: true }),
    state('accounts/', false, 'each provider account’s own folder: the provider keeps its login there'),
    state('browser/', false, 'the Genie browser’s profiles, one per workspace: the sites’ logins'),
    state('secrets/', false, 'the sealed secrets of a host with no OS keychain (GENIE_SECRET_BACKEND=file)'),
    state('v1-import.json', false, 'that Genie 1’s data was imported here, once'),
    state('v1-reap.json', false, 'what of Genie 1’s was ended here, once'),
    state('runtime/agent-inbox-access-migrated.json', false, 'that the agents’ inbox access was moved, once'),
    // Left by an older Genie, with no writer on this line: kept, because nothing here can make them again.
    state('genie.ini', false, 'an older Genie’s file'),
    state('legacy/', false, 'an older Genie’s folder'),
    state('.tynn-cli-cleanup-v1.json', false, 'that an older Genie’s Tynn CLI entries were cleaned up, once'),

    // --- MACHINE: how to reach this host, here and now -----------------------------------------------------------------
    machine('runtime/host.json', 'this host’s pid, endpoint, protocol and build', { atStart: true }),
    machine('runtime/host.token', 'the token a window says to this host', { atStart: true }),
    machine('runtime/host.sock', 'this host’s endpoint (not Windows, where it is a pipe)'),
    machine('mcp-endpoint.json', 'the port and token of Genie’s MCP server', { atStart: true }),
    machine('app-inbox-endpoint.json', 'the app inbox’s port'),
    machine('runtime/genie.pid', 'the window’s pid'),
    machine('runtime/doctor-hold.json', 'that the doctor holds Genie stopped'),
    machine('runtime/host-proxy.json', 'the proxy routes the OS last gave'),
    machine('runtime/provider-programs.json', 'where each provider’s program is on this machine'),
    machine('runtime/mobile-tls/', 'this machine’s tailnet certificate', { names: ['cert.pem', 'key.pem'] }),

    // --- MACHINE: what is running, and what the last run left ---------------------------------------------------------
    machine('runtime/children.json', 'the processes this host started'),
    machine('runtime/ptys.json', 'the terminals this host holds'),
    machine('runtime/safe-mode.json', 'whether the last run ended cleanly', { atStart: true }),
    machine('runtime/alive.json', 'this run’s heartbeat'),
    machine('runtime/alive.prev.json', 'the last run’s heartbeat'),
    machine('runtime/clean-exit.json', 'that the last run ended cleanly'),
    machine('runtime/crash/', 'the crash records'),
    machine('runtime/lifecycle.log', 'the host’s own log', { atStart: true }),
    machine('runtime/lifecycle.log.1', 'the host’s own log, before the last turn-over'),
    machine('runtime/update-failed.json', 'the last update that failed'),
    machine('runtime/process-logs/', 'what the kept processes printed'),
    machine('logs/', 'what the host, the browser process and the updater printed', { names: ['genie-host.log', 'genie-browser.log', 'genie-updater.log'] }),

    // --- MACHINE: installed, downloaded or generated; made again when it is missing -----------------------------------
    machine('host/', 'the host’s own copy of its runtime and its code, made from the install'),
    machine('genie2-toolchain/', 'the runtimes and browsers Genie installed', { names: ['sets.json', 'toolchain-env.json', 'cacert.pem', 'zz-genie-ca.ini'] }),
    machine('runtime/caddy-bin/', 'the front door’s program, copied from the install'),
    machine('runtime/caddy/', 'the front door’s configuration and its own storage'),
    machine('runtime/prism-supervisor/', 'an older supervisor build'),
    machine('runtime/engine-config/', 'the service engines’ configuration, written from services.json'),
    machine('runtime/sites/', 'each site’s generated configuration'),
    machine('runtime/php-trust/', 'the CA bundle PHP is given', { names: ['genie-ca-bundle.pem', 'zzz-genie-trust.ini'] }),
    machine('runtime/hosts.next', 'the hosts file about to be installed'),
    machine('runtime/mailpit-auth/', 'the mail engine’s password file, written from the inboxes'),
    machine('runtime/untrusted-agent/', 'the instructions generated for an agent in a workspace not yet trusted'),
    machine('runtime/local-staging/', 'uploads on their way to a workspace'),
    machine('runtime/.updater/', 'the updater’s own Chromium folder'),
    machine('browser/.process/', 'the browser process’s own Chromium folder', { names: ['window-origin.json'] }),
    machine('cache/', 'scratch, one folder per process'),
    machine('marketplace-staging/', 'a plugin’s download on its way in', { names: ['activation.json'] }),
    machine('plugin-sandbox/', 'the guard scripts generated for plugins'),
    machine('marketplace-publisher-keys.json', 'the publishers’ public keys, as last fetched'),
    machine('v1-services.json', 'what Genie 1’s engines looked like when they were taken over'),

    // --- MACHINE: readings and notices that are asked again ----------------------------------------------------------
    machine('headroom-board.json', 'the last rate-limit readings'),
    machine('limit-alerts-armed.json', 'which rate-limit alerts already fired'),
    machine('limit-alert-notices.json', 'the rate-limit notices not yet dismissed'),
    machine('switch-offers.json', 'the account switches offered'),
    machine('claude-design-state.json', 'a sign-in to Claude Design that is under way'),
];

/** What a write left half-done beside a file: `x.json.<pid>.<n>.tmp`, `x.json.<uuid>.tmp`, `x.json.tmp`, and a file set aside as unreadable. */
const LEFT_BEHIND = /(?:\.\d+(?:\.\d+)?\.tmp|\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp|\.tmp|\.unreadable|\.corrupt-\d+)$/;
/** SQLite's own files beside a database. */
const DATABASE_SIDE = /-(?:wal|shm|journal)$/;

const FILES = new Map<string, DataRootRule>();
const FOLDERS: DataRootRule[] = [];
for (const rule of DATA_ROOT_RULES) {
    if (rule.path.endsWith('/')) FOLDERS.push(rule);
    else FILES.set(rule.path, rule);
}
// The longest folder first: `browser/.process/` before `browser/`.
FOLDERS.sort((a, b) => b.path.length - a.path.length);

/**
 * The rule a path under the root falls under, or null when it is in no list. The path is relative to the root, with
 * either separator. A folder that only holds listed things (`runtime`) is not itself listed.
 */
export function classifyDataPath(relative: string): DataRootRule | null {
    const parts = relative.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
    if (parts.length === 0 || parts.some((p) => p === '' || p === '.' || p === '..')) return null;
    const path = parts.join('/');
    const exact = FILES.get(path);
    if (exact) return exact;
    for (const folder of FOLDERS) if (`${path}/`.startsWith(folder.path)) return folder;
    const side = path.replace(DATABASE_SIDE, '');
    if (side !== path) return FILES.get(side) ?? null;
    const whole = path.replace(LEFT_BEHIND, '');
    if (whole !== path && FILES.has(whole)) return { path, kind: 'machine', holds: `what a write of ${whole} left half-done` };
    return null;
}

export interface DataRootManifest {
    readonly format: number;
    /** The host build that wrote it. */
    readonly build: string;
    readonly state: ReadonlyArray<{ readonly path: string; readonly travels: boolean }>;
    readonly machine: readonly string[];
}

/** The manifest: the rules' own words and the build. Nothing is read from the root, so nothing of the root can be in it. */
export function dataRootManifest(build: string): DataRootManifest {
    return {
        format: DATA_ROOT_FORMAT,
        build,
        state: DATA_ROOT_RULES.filter((r) => r.kind === 'state').map((r) => ({ path: r.path, travels: r.travels === true })),
        machine: DATA_ROOT_RULES.filter((r) => r.kind === 'machine').map((r) => r.path),
    };
}

/** Written whole (a temp file, then renamed over the last one). */
export async function writeDataRootManifest(home: string, build: string): Promise<void> {
    await writeJsonAtomic(join(home, DATA_ROOT_FILE), dataRootManifest(build));
}
