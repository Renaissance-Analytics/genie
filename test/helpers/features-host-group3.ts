import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { signedOutGithubView } from '../../src/core/github.js';
import { planInstall } from '../../src/core/toolchain.js';
import type { ToolchainActivity } from '../../src/core/toolchain-risk.js';
import type { FeatureAction, FeatureData } from '../../src/renderer/features.js';
import type { HostFeatureMachinePorts } from '../../src/main/features-host.js';
import type { WindowServices } from '../../src/main/compose.js';
import { featureSnapshot, handleFeatureAction } from '../../src/main/feature-ipc.js';
import { trustSteps } from '../../src/main/hosting-trust.js';
import { hostCatalog } from '../../src/main/genie-catalog.js';
import { PluginsService } from '../../src/main/plugins-host.js';
import { RemoteAccessHost } from '../../src/main/remote-access-host.js';
import { remoteAccess } from '../../src/main/remote-access.js';
import { ensureFirewallRule, firewallReader, readFirewallRule, removeFirewallRule } from '../../src/main/remote-firewall.js';
import { installTailscale, parseTailscaleStatus, tailscaleUp } from '../../src/main/tailscale-cli.js';
import { checkAndRepair, installTool, type ToolchainOpsPorts } from '../../src/main/toolchain-ops.js';
import { probeTools, runUpdate, type CommandRunner } from '../../src/main/toolchain-prober.js';
import type { TynnAccountPort, TynnStatus } from '../../src/main/tynn-account.js';
import type { GithubAccountPort } from '../../src/main/github-account.js';
import { groupTwoFixture, settleFeatures } from './features-host-group2.js';

/** Real host services/planners. Only account responses and OS boundaries are synthetic; no window composition. */
export async function groupThreeFixture() {
    const dir = await mkdtemp(join(tmpdir(), 'genie-features-group-three-')), pluginsDir = join(dir, 'plugins');
    const listeners = new Set<() => void>();
    const changed = () => { for (const listener of listeners) listener(); };
    const onChange = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
    await mkdir(join(pluginsDir, 'fixture'), { recursive: true });
    await writeFile(join(pluginsDir, 'fixture', 'genie-package.json'), JSON.stringify({ id: 'com.example.fixture', name: 'Fixture', version: '1.0.0',
        publisher: { name: 'Example', keyId: 'fixture' }, capabilities: { genieApi: [], network: { hosts: ['example.com'] } } }));
    const plugins = await PluginsService.open({ dir: pluginsDir, keys: {}, publisherChecksOff: () => true });
    const offPlugins = plugins.onEvent(changed);
    const access = await RemoteAccessHost.open({ home: dir, hostName: 'fixture-host', now: () => 7_000,
        api: { invoke: async () => { throw new Error('fixture remote API is not used'); }, onEvent: () => () => {}, workspaceOfAgent: () => null },
        transport: { onConnection: () => () => {} } });
    const offRemote = access.onChange(changed);
    let listenerUp = false;
    const listener = { start: vi.fn(async () => { listenerUp = true; }), stop: vi.fn(async () => { listenerUp = false; }),
        unavailable: () => listenerUp ? null : 'fixture listener stopped' };
    const remoteSwitch = remoteAccess({ listener, enabled: () => base.settings.get('remote_access') === true, onChange: changed });
    let tynnStatus: TynnStatus = { signedIn: false };
    const accountCalls: Array<readonly unknown[]> = [];
    const tynn: TynnAccountPort = {
        status: () => tynnStatus, host: () => 'https://tynn.example.com', onChange,
        startSignIn: async () => { accountCalls.push(['tynn.start']); return { url: 'https://tynn.example.com/genie/sign-in' }; },
        signIn: async code => { accountCalls.push(['tynn.code', code]); return { ok: false, reason: 'fixture sign-in code is not accepted' }; },
        signOut: async () => { accountCalls.push(['tynn.out']); tynnStatus = { signedIn: false }; changed(); return { ok: true, revoked: true }; },
    };
    let githubView = signedOutGithubView('fixture GitHub is signed out');
    const github: GithubAccountPort = { view: () => githubView, onChange,
        startSignIn: async () => { accountCalls.push(['github.start']); }, cancelSignIn: () => { accountCalls.push(['github.cancel']); },
        refresh: async () => { accountCalls.push(['github.refresh']); }, openPage: async target => { accountCalls.push(['github.open', target]); },
        signOut: async () => { accountCalls.push(['github.out']); },
    };
    const keyring = { active: false, pressed: 0, cancelled: 0 };
    const issueCalls: Array<readonly unknown[]> = [];
    const iw = { work: { linked: false, line: { tone: 'muted' as const, text: 'fixture IssueWatch is not linked' }, counts: null,
        repos: [], feedback: [], empty: null, recent: [], watched: null } };

    const commands: Array<{ binary: string; args: readonly string[] }> = [];
    const missing = new Set<string>();
    const run: CommandRunner = async (binary, args) => {
        commands.push({ binary, args });
        if (binary === 'pkexec') { missing.delete('git'); versions.git = '2.51.0'; return { stdout: '', exitCode: 0 }; }
        if (binary === 'which') return { stdout: '', exitCode: 1 };
        if (binary === 'php' && args[0] === '-r') return { stdout: '', exitCode: 0 };
        if (missing.has(binary)) return { stdout: '', exitCode: 127 };
        return { stdout: versions[binary] ?? '', exitCode: 0 };
    };
    const versions: Record<string, string> = { git: '2.50.0', node: '22.1.0', php: '8.4.0', claude: '2.1.0', codex: '0.1.0' };
    const files = new Map<string, string>(), directories = new Set<string>(), env = new Map<string, string>();
    const progress: Array<unknown> = [];
    const ops: ToolchainOpsPorts = { platform: 'linux', run, dataDir: dir, systemRoot: '/fixture', packageManager: async () => 'apt', now: () => 7_000,
        env: { get: name => env.get(name), set: (name, value) => { env.set(name, value); } },
        fs: { exists: path => files.has(path) || directories.has(path), readText: path => files.get(path) ?? null, writeText: (path, value) => { files.set(path, value); },
            mkdirp: path => { directories.add(path); }, remove: path => { files.delete(path); directories.delete(path); } }, progress: step => { progress.push(step); changed(); } };
    let activity: ToolchainActivity = { sessions: [], processes: [], engines: [] };
    const toolchain: NonNullable<HostFeatureMachinePorts['effects']['toolchain']> = {
        probe: () => probeTools(run, async () => ({ version: '2.51.0', source: 'fixture' }), 'linux'), now: () => 7_000,
        activity: async () => activity, update: (tool, version) => runUpdate(tool, { platform: 'linux', packageManager: 'apt' }, run, version ?? '2.51.0'),
        updating: row => { progress.push(row); changed(); }, install: (tool, consent) => installTool(tool, consent, ops),
        preview: async tool => planInstall({ tool, platform: 'linux', packageManager: 'apt' }), repair: () => checkAndRepair(ops),
    };
    const firewallState = { present: false, exit: 0, reads: 0 };
    const elevations: string[] = [];
    // The existing firewall tests emulate this platform gate too. Serialize and restore it exactly;
    // the real planners execute, but their netsh/elevation ports below never start an OS command.
    let platformQueue = Promise.resolve();
    const onWindows = <T>(work: () => Promise<T>): Promise<T> => {
        const next = platformQueue.then(async () => {
            const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
            Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
            try { return await work(); } finally { Object.defineProperty(process, 'platform', original); }
        });
        platformQueue = next.then(() => {}, () => {}); return next;
    };
    const firewall = firewallReader(() => onWindows(() => readFirewallRule(7421, async () => { firewallState.reads++;
        return { stdout: firewallState.present ? 'Rule Name: Genie Remote Access\n----------\nEnabled: Yes\nDirection: In\nProfiles: Domain,Private,Public\nAction: Allow\nProtocol: TCP\nLocalPort: 7421\nRemoteIP: 100.64.0.0/255.192.0.0\n' : 'No rules match the specified criteria.', code: firewallState.present ? 0 : 1 };
    })), { minIntervalMs: 100, now: () => 7_000 });
    const elevate = (remove: boolean) => async (script: string) => {
        const encoded = /'-EncodedCommand','([^']+)'/.exec(script)?.[1];
        if (!encoded) throw new Error('fixture elevation did not receive the real encoded script');
        elevations.push(Buffer.from(encoded, 'base64').toString('utf16le'));
        if (firewallState.exit === 0) firewallState.present = !remove;
        return firewallState.exit;
    };
    const tailCalls: Array<readonly unknown[]> = [];
    const tailscale = {
        status: () => ({ ...parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { HostName: 'fixture-tail', TailscaleIPs: ['100.64.0.1'], Online: true }, Peer: {} })), installed: true, state: 'running' as const, remedy: null }),
        up: () => tailscaleUp({ platform: 'linux', cliPath: () => '/fixture/tailscale', run: async (cli, args) => { tailCalls.push([cli, args]); return { stdout: '{"BackendState":"Stopped"}', stderr: '' }; },
            start: (cli, args, timeout) => { tailCalls.push([cli, args, timeout]); return { onOutput: () => {}, done: Promise.resolve() }; } }),
        install: () => installTailscale({ platform: 'linux', installed: () => null, download: async () => { throw new Error('Linux has no installer download'); } }),
    };
    let base!: Awaited<ReturnType<typeof groupTwoFixture>>;
    const machine: HostFeatureMachinePorts = {
        services: { remote: access.remote, pairing: access.pairing, pluginsDir,
            plugins: { list: () => plugins.dump().entries, setEnabled: async (id, enabled) => await plugins.call('setEnabled', [id, enabled]) === true,
                setNetworkAllowed: async (id, allowed) => await plugins.call('setNetworkAllowed', [id, allowed]) === true },
            catalogDefinitions: () => hostCatalog(plugins.plugins()).list(),
            integrations: () => ({ mcp: { url: 'http://127.0.0.1/fixture', verified: null, tools: [] }, agentFiles: [] }),
            workspaceTrust: { trust: id => base.hosting.trust.trust(id), untrust: id => base.hosting.trust.untrust(id) },
            syncAgentDocs: async () => { throw new Error('fixture sync is not wired yet'); }, syncConfig: async () => { throw new Error('fixture sync is not wired yet'); },
        },
        effects: { tynnAccount: tynn, githubAccount: github, toolchain, remoteAccess: remoteSwitch,
            keyring: { view: () => keyring.active ? { state: 'not-installed', step: null, failure: null, manual: null, packages: 'fixture-keyring' } : null,
                fix: async () => { keyring.pressed++; changed(); }, cancel: () => { keyring.cancelled++; changed(); }, notice: () => null },
            issueWatch: () => iw, issueWatchRefresh: async id => { issueCalls.push(['refresh', id]); },
            issueWatchSetRepo: async (...args) => { issueCalls.push(['setRepo', ...args]); },
            firewall: { ...firewall, allow: () => onWindows(() => ensureFirewallRule(7421, elevate(false))),
                remove: () => onWindows(() => removeFirewallRule(elevate(true))) }, tailscale,
            tynnWorkstation: () => ({ registered: true, host: 'https://tynn.example.com', workstationId: 'fixture-workstation' }),
            appVersion: () => '2.0.0-beta.63', whatsNew: () => ({ version: '2.0.0-beta.63', notes: 'fixture release notes' }),
        }, onChange,
    };
    base = await groupTwoFixture(machine);
    // The Unverified fixture is admitted under the same developer setting the snapshot reports.
    await base.settings.set('publisher_checks_off', true);
    // The existing shared human path over these SAME owned contributors, without composing a window.
    // Its broad historical type is confined to this parity fixture; production gets the narrow machine port above.
    const legacyServices = { ...base.service.ports, ...base.hosting, ...machine.services, supervisor: base.supervisor,
        agentAddresses: () => [], flowScheduler: { runNow: base.service.ports.runFlow },
        pluginsRefresh: base.service.ports.refreshPlugins, trustSteps: () => trustSteps(base.hosting.trust.entries()),
        workspaceVisible: (id: string) => base.visible.has(id),
    } as unknown as WindowServices;
    const legacyAct = (action: FeatureAction) => handleFeatureAction(legacyServices, action, { toolStatuses: null, knowledgeQuery: '' }, machine.effects);
    const legacySnapshot = () => featureSnapshot(legacyServices, { toolStatuses: null, knowledgeQuery: '' }, machine.effects);
    const act = async (action: FeatureAction): Promise<FeatureData> => {
        const result = await base.outcome('features.act', [action]);
        return result.ok ? result.value as FeatureData : Promise.reject(new Error(result.reason));
    };
    const close = async () => { await base.close(); offPlugins(); offRemote(); await access.close(); await rm(dir, { recursive: true, force: true }); };
    return { ...base, machine, plugins, access, accountCalls, keyring, issueCalls, toolchain, ops, run, commands, missing, versions, progress, legacyAct, legacySnapshot,
        firewall, firewallState, elevations, tailscale, tailCalls, listener, listenerUp: () => listenerUp, act, changed, close,
        signedIn: () => { tynnStatus = { signedIn: true, host: 'https://tynn.example.com', user: { name: 'Someone', email: 'someone@example.com' } }; changed(); },
        githubChange: () => { githubView = { ...githubView, message: 'fixture account changed' }; changed(); },
        activity: (value: ToolchainActivity) => { activity = value; },
        pluginState: () => readFile(join(pluginsDir, 'plugins-state.json'), 'utf8'), settle: settleFeatures };
}
export type GroupThreeFixture = Awaited<ReturnType<typeof groupThreeFixture>>;
