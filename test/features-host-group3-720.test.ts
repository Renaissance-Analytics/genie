import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { catalogEditors, catalogPanels } from '../src/core/catalog-projections.js';
import { HOST_TOOLS } from '../src/core/toolchain.js';
import type { FeatureAction, FeatureData } from '../src/renderer/features.js';
import { groupThreeFixture, type GroupThreeFixture } from './helpers/features-host-group3.js';

let f: GroupThreeFixture;
beforeEach(async () => { f = await groupThreeFixture(); });
afterEach(async () => { await f?.close(); });
async function read(): Promise<FeatureData> {
    const result = await f.outcome('features.snapshot');
    expect(result, result.ok ? undefined : result.reason).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('the preceding assertion failed');
    return result.value as FeatureData;
}
async function act(action: FeatureAction): Promise<FeatureData> {
    const result = await f.outcome('features.act', [action]);
    expect(result, result.ok ? undefined : result.reason).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('the preceding assertion failed');
    return result.value as FeatureData;
}

describe('host feature group three with no window (Tynn #720)', () => {
    it('account and integration facts come from the supplied host accounts', async () => {
        f.signedIn();
        expect((await read()).integrations).toMatchObject({ tynnSignedIn: true,
            tynn: { host: 'https://tynn.example.com', user: { name: 'Someone', email: 'someone@example.com' } },
            github: f.machine.effects.githubAccount!.view(), mcp: { url: 'http://127.0.0.1/fixture' } });
    });
    it('the keyring card is the owned reading rather than a fabricated ready state', async () => {
        f.keyring.active = true;
        expect((await read()).integrations?.keyring).toEqual(f.machine.effects.keyring!.view());
        expect((await read()).integrations?.keyring).toMatchObject({ state: 'not-installed' });
    });
    it('IssueWatch reads the supplied workspace view', async () => {
        expect((await read()).issueWatch).toEqual(f.machine.effects.issueWatch!());
    });
    it('plugin rows and panel and editor projections come from the owned catalog', async () => {
        const definitions = f.machine.services.catalogDefinitions(), data = await read();
        expect(data.plugins).toEqual({ dir: f.machine.services.pluginsDir, publisherChecksOff: true, entries: f.plugins.dump().entries,
            panels: catalogPanels(definitions), editors: catalogEditors(definitions) });
        expect(data.plugins?.entries).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'com.example.fixture', state: 'enabled', unverified: true })]));
    });
    it('remote facts and workstation registration reflect the actual host owner', async () => {
        expect((await read()).remote).toMatchObject({ host: 'fixture-host', url: null, locked: false, pin: null,
            devices: [], connections: [], pairRequests: [], enabled: false,
            tynnWorkstation: { registered: true, workstationId: 'fixture-workstation' } });
    });
    it('version and release notes are supplied by the host without Electron', async () => {
        expect(await read()).toMatchObject({ version: '2.0.0-beta.63', whatsNew: { version: '2.0.0-beta.63', notes: 'fixture release notes' } });
    });
    it('Tynn sign-in retains its supplied link without claiming a browser was opened', async () => {
        expect((await act({ kind: 'integrations.tynnSignIn' })).integrations?.tynn).toMatchObject({ signInUrl: 'https://tynn.example.com/genie/sign-in', message: null });
        expect(f.accountCalls).toEqual([['tynn.start']]); expect(f.invokeWindow).not.toHaveBeenCalled();
    });
    it('a returned Tynn code refusal stays visible beside the retained link', async () => {
        await act({ kind: 'integrations.tynnSignIn' });
        expect((await act({ kind: 'integrations.tynnCode', code: 'fixture-code' })).integrations?.tynn)
            .toMatchObject({ signInUrl: 'https://tynn.example.com/genie/sign-in', message: 'fixture sign-in code is not accepted' });
        expect(f.accountCalls.at(-1)).toEqual(['tynn.code', 'fixture-code']);
    });
    it('Tynn sign-out uses the owned account and clears caller sign-in state', async () => {
        f.signedIn();
        expect((await act({ kind: 'integrations.tynnSignOut' })).integrations).toMatchObject({ tynnSignedIn: false, tynn: { user: null, signInUrl: null, message: null } });
        expect(f.accountCalls).toEqual([['tynn.out']]);
    });
    it('GitHub start, cancel, refresh and sign-out call the owned account', async () => {
        for (const kind of ['integrations.githubSignIn', 'integrations.githubCancelSignIn', 'integrations.githubRefresh', 'integrations.githubSignOut'] as const) await act({ kind });
        expect(f.accountCalls).toEqual([['github.start'], ['github.cancel'], ['github.refresh'], ['github.out']]);
    });
    it('keyring Fix and Cancel use the owned operation ports', async () => {
        await act({ kind: 'keyring.fix' }); await act({ kind: 'keyring.cancel' });
        expect(f.keyring).toMatchObject({ pressed: 1, cancelled: 1 });
    });
    it('IssueWatch refresh and repo changes preserve all operation arguments', async () => {
        await act({ kind: 'issueWatch.refresh', workspaceId: 'work' });
        await act({ kind: 'issueWatch.setRepo', workspaceId: 'work', owner: 'example', repo: 'fixture', enabled: true, includeUpstream: false });
        expect(f.issueCalls).toEqual([['refresh', 'work'], ['setRepo', 'work', 'example', 'fixture', { enabled: true, includeUpstream: false }]]);
    });
    it('disabling an owned plugin writes its real persistent state', async () => {
        expect((await act({ kind: 'plugins.setEnabled', id: 'com.example.fixture', enabled: false })).plugins?.entries)
            .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'com.example.fixture', state: 'disabled' })]));
        expect(JSON.parse(await f.pluginState())).toContain('com.example.fixture');
    });
    it('an Unverified plugin network choice is applied by the real plugin policy', async () => {
        expect((await act({ kind: 'plugins.setNetworkAllowed', id: 'com.example.fixture', allowed: true })).plugins?.entries)
            .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'com.example.fixture', unverified: true, networkAllowed: true })]));
    });
    it('an unknown plugin preserves the existing named refusal instead of success', async () => {
        expect(await f.outcome('features.act', [{ kind: 'plugins.setEnabled', id: 'missing', enabled: true }])).toEqual({ ok: false,
            reason: 'missing could not be enabled: it is not an installable plugin here' });
    });
    it('issuing a PIN updates the actual host rather than a window replica', async () => {
        const data = await act({ kind: 'remote.issuePin' });
        expect(data.remote?.pin).toEqual(f.access.remote.activePin());
        expect(data.remote?.pin?.code).toMatch(/^\d{6}$/); expect(f.invokeWindow).not.toHaveBeenCalled();
    });
    it('Lock and Unlock change the owned remote service', async () => {
        expect((await act({ kind: 'remote.lock' })).remote?.locked).toBe(true); expect(f.access.remote.locked()).toBe(true);
        expect((await act({ kind: 'remote.unlock' })).remote?.locked).toBe(false); expect(f.access.remote.locked()).toBe(false);
    });
    it('remote Restart follows the canonical serialized listener switch', async () => {
        await f.settings.set('remote_access', true);
        await act({ kind: 'remote.restart' });
        expect(f.listener.stop).toHaveBeenCalledTimes(1); expect(f.listener.start).toHaveBeenCalledTimes(1); expect(f.listenerUp()).toBe(true);
    });
    it('revoking an unknown device preserves the existing refusal', async () => {
        expect(await f.outcome('features.act', [{ kind: 'remote.revokeDevice', deviceId: 'missing' }])).toEqual({ ok: false, reason: 'no device missing' });
    });
    it('the firewall reading uses the real parser and owned reader', async () => {
        await f.firewall.refresh();
        expect((await read()).remote).toMatchObject({ firewall: true, firewallRule: { state: 'absent' } });
    });
    it('firewall Allow uses the real script planner then re-reads the rule', async () => {
        const data = await act({ kind: 'remote.allowFirewall' });
        expect(f.elevations).toHaveLength(1); expect(f.elevations[0]).toContain('7421');
        expect(f.firewallState.reads).toBe(1); expect(data.remote).toMatchObject({ firewallRule: { state: 'present', covers: true }, firewallOutcome: 'Allowed: devices on your tailnet can reach this port.' });
    });
    it('a declined firewall prompt is cancellation with the actual unchanged rule', async () => {
        f.firewallState.exit = 1223;
        expect((await act({ kind: 'remote.allowFirewall' })).remote).toMatchObject({ firewallRule: { state: 'absent' }, firewallOutcome: 'Cancelled: Windows asked, and nothing was changed.' });
        expect(f.firewallState.present).toBe(false); expect(f.firewallState.reads).toBe(1);
    });
    it('firewall Remove plans deletion and reads the real resulting absence', async () => {
        f.firewallState.present = true;
        expect((await act({ kind: 'remote.removeFirewall' })).remote).toMatchObject({ firewallRule: { state: 'absent' }, firewallOutcome: 'Removed: Windows Firewall no longer lets devices on your tailnet reach this port.' });
        expect(f.elevations[0]).toContain('delete'); expect(f.firewallState.reads).toBe(1);
    });
    it('Tailscale facts come from the real status parser', async () => {
        expect((await read()).remote?.tailscale).toEqual(f.tailscale.status());
        expect((await read()).remote?.tailscale?.self?.hostname).toBe('fixture-tail');
    });
    it('Tailscale Connect runs the real bounded up planner through an inert process port', async () => {
        expect((await act({ kind: 'tailscale.up' })).remote?.tailscaleOutcome).toBe('Connected to your tailnet.');
        expect(f.tailCalls).toEqual([['/fixture/tailscale', ['status', '--json']], ['/fixture/tailscale', ['up', '--timeout=300s'], 330_000]]);
    });
    it('CONTROL: an unasked toolchain stays unknown and runs no scan', async () => {
        expect((await read()).toolchain).toBeNull(); expect(f.commands).toEqual([]);
    });
    it('toolchain Check uses the real prober and preserves its measured versions', async () => {
        const data = await act({ kind: 'toolchain.check', force: true });
        expect(data.toolchain?.checkedAt).toBe(7_000); expect(data.toolchain?.tools).toHaveLength(HOST_TOOLS.length);
        expect(data.toolchain?.tools).toEqual(expect.arrayContaining([expect.objectContaining({ tool: 'git', installed: '2.50.0' })]));
        expect(f.commands.some(call => call.binary === 'git')).toBe(true);
    });
    it('a consented tool install uses the real installer plan and re-probes its result', async () => {
        f.missing.add('git'); await act({ kind: 'toolchain.check', force: true });
        const data = await act({ kind: 'toolchain.install', tool: 'git', consent: true });
        expect(f.commands.filter(call => call.binary === 'pkexec')).toHaveLength(1);
        expect(data.toolchain?.tools).toEqual(expect.arrayContaining([expect.objectContaining({ tool: 'git', installed: '2.51.0' })]));
        expect(data.toolchain?.result).toBe('git 2.51.0 is installed.');
    });
    it('missing tool-install consent remains a row refusal and runs no installer', async () => {
        await act({ kind: 'toolchain.check', force: true });
        const data = await act({ kind: 'toolchain.install', tool: 'git', consent: false });
        expect(data.toolchain?.refusals).toEqual([{ tool: 'git', reason: 'Genie installs nothing without your go-ahead; git was not installed' }]);
        expect(f.commands.filter(call => call.binary === 'pkexec')).toEqual([]);
    });
    it('toolchain Update uses the real update planner and re-probes the new version', async () => {
        await act({ kind: 'toolchain.check', force: true });
        const data = await act({ kind: 'toolchain.update', tool: 'git', version: '2.51.0' });
        expect(f.commands.filter(call => call.binary === 'pkexec')).toEqual([{ binary: 'pkexec', args: ['apt-get', 'install', '--only-upgrade', '-y', 'git'] }]);
        expect(data.toolchain?.tools).toEqual(expect.arrayContaining([expect.objectContaining({ tool: 'git', installed: '2.51.0' })]));
        expect(data.toolchain?.updated).toEqual({ tool: 'git', version: '2.51.0' });
    });
    it('the real update-risk guard blocks a CLI whose agent is running', async () => {
        await act({ kind: 'toolchain.check', force: true }); f.activity({ sessions: [{ provider: 'claude', label: 'fixture Claude' }], processes: [], engines: [] });
        const data = await act({ kind: 'toolchain.update', tool: 'claude-code' });
        expect(data.toolchain?.refusals).toEqual([expect.objectContaining({ tool: 'claude-code', reason: expect.stringContaining('fixture Claude') })]);
        expect(f.commands.filter(call => call.binary === 'pkexec')).toEqual([]);
    });
    it('Check and repair uses the real repair planner and records its measured report', async () => {
        await act({ kind: 'toolchain.check', force: true });
        const data = await act({ kind: 'toolchain.repair' });
        expect(data.toolchain).toMatchObject({ repairedAt: 7_000, findings: [] });
        expect(f.commands.some(call => call.binary === 'which')).toBe(true); expect(f.progress.at(-1)).toBeNull();
    });
    it('account and plugin changes invalidate owned feature facts', async () => {
        const events = f.changes(); f.signedIn(); await f.settle();
        expect(events.snapshots.at(-1)?.integrations?.tynnSignedIn).toBe(true);
        await f.plugins.call('setEnabled', ['com.example.fixture', false]); await f.settle();
        expect(events.snapshots.at(-1)?.plugins?.entries).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'com.example.fixture', state: 'disabled' })]));
    });
    it('remote and progress changes use the host change source and unsubscribe ends delivery', async () => {
        const events = f.changes(); f.access.remote.lock(); await f.settle();
        expect(events.snapshots.at(-1)?.remote?.locked).toBe(true);
        f.toolchain.updating!({ tool: 'git', step: 'fixture progress' }); await f.settle();
        expect(events.revisions.length).toBeGreaterThan(1);
        events.off(); const count = events.revisions.length; f.githubChange(); f.changed(); await f.settle(); expect(events.revisions).toHaveLength(count);
    });
    it('CONTROL: the canonical plugin service persists a choice without the feature service', async () => {
        expect((await f.legacySnapshot()).plugins?.entries).toEqual(f.plugins.dump().entries);
        expect(f.plugins.dump().entries).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'com.example.fixture', state: 'enabled' })]));
        expect(await f.plugins.call('setEnabled', ['com.example.fixture', false])).toBe(true); expect(JSON.parse(await f.pluginState())).toContain('com.example.fixture');
    });
    it('CONTROL: the canonical remote host and serialized switch work without the feature service', async () => {
        expect((await f.legacyAct({ kind: 'remote.lock' })).remote?.locked).toBe(true);
        expect(f.access.remote.locked()).toBe(true); f.access.remote.unlock(); expect(f.access.remote.locked()).toBe(false);
        await f.settings.set('remote_access', true);
        await f.machine.effects.remoteAccess!.restart(); expect(f.listener.start).toHaveBeenCalledTimes(1); expect(f.listenerUp()).toBe(true);
    });
    it('CONTROL: the real OS planners run through the inert boundaries without the feature service', async () => {
        f.missing.add('git'); expect((await f.legacyAct({ kind: 'toolchain.install', tool: 'git', consent: true })).toolchain?.result).toBe('git 2.51.0 is installed.');
        expect(f.commands.some(call => call.binary === 'pkexec')).toBe(true);
        expect((await f.legacyAct({ kind: 'remote.allowFirewall' })).remote?.firewallRule).toMatchObject({ state: 'present', covers: true });
        expect((await f.legacyAct({ kind: 'tailscale.up' })).remote?.tailscaleOutcome).toBe('Connected to your tailnet.'); expect(f.tailCalls).toHaveLength(2);
    });
});
