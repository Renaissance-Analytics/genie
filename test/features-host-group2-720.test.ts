import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineStatusView } from '../src/core/engine-reconcile.js';
import { trustSteps } from '../src/main/hosting-trust.js';
import type { FeatureAction, FeatureData } from '../src/renderer/features.js';
import { groupTwoFixture, serviceForm, siteForm, settleFeatures, type GroupTwoFixture } from './helpers/features-host-group2.js';

let f: GroupTwoFixture;
beforeEach(async () => { f = await groupTwoFixture(); });
afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });

async function read(): Promise<FeatureData> {
    const result = await f.outcome('features.snapshot');
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('the preceding assertion failed');
    return result.value as FeatureData;
}
async function act(action: FeatureAction): Promise<FeatureData> {
    const result = await f.outcome('features.act', [action]);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('the preceding assertion failed');
    return result.value as FeatureData;
}
const refusal = (action: FeatureAction) => f.outcome('features.act', [action]);
const logCalls = () => f.dockerCalls.filter(args => args[0] === 'logs');
const pulls = () => f.dockerCalls.filter(args => args[0] === 'pull');

describe('host feature group two with no window (Tynn #720)', () => {
    it('service snapshots read the owned registry and actual engine status', async () => {
        const engine = await f.seedEngine();
        expect((await read()).services?.instances).toEqual([expect.objectContaining({ instance: expect.objectContaining({ id: engine.id }), status: 'running' })]);
    });
    it('the first engine read waits for its real answer rather than fabricating an empty section', async () => {
        const engine = await f.seedEngine(); let release!: (value: EngineStatusView[]) => void;
        const ready = new Promise<EngineStatusView[]>(resolve => { release = resolve; });
        const measure = f.hostingCalls.engineStatuses.mockClear().mockReturnValue(ready);
        let answered = false; const pending = read().finally(() => { answered = true; });
        try {
            await settleFeatures(); expect(measure).toHaveBeenCalledTimes(1); expect(answered).toBe(false);
        } finally { release([{ instance: engine, status: 'running' }]); await pending; }
    });
    it('a slow later engine read shares one request, serves the last answer and invalidates when it lands', async () => {
        const engine = await f.seedEngine(); expect((await read()).services?.instances[0]?.status).toBe('running');
        let release!: (value: EngineStatusView[]) => void;
        const ready = new Promise<EngineStatusView[]>(resolve => { release = resolve; });
        const measure = f.hostingCalls.engineStatuses.mockClear().mockReturnValue(ready);
        const events = f.changes();
        try {
            const [one, two] = await Promise.all([read(), read()]);
            expect(one.services?.instances[0]?.status).toBe('running'); expect(two.services?.instances[0]?.status).toBe('running');
            expect(measure).toHaveBeenCalledTimes(1);
            measure.mockResolvedValue([{ instance: engine, status: 'exited' }]);
            release([{ instance: engine, status: 'exited' }]); await settleFeatures();
            expect(events.snapshots.at(-1)?.services?.instances[0]?.status).toBe('exited');
        } finally { release([{ instance: engine, status: 'exited' }]); }
    });
    it('Docker unavailability is reported with its real reason instead of a healthy status', async () => {
        await f.seedEngine(); f.docker.down = true;
        expect((await read()).services?.instances).toEqual([expect.objectContaining({ status: 'docker-not-running', note: expect.stringContaining('fixture Docker daemon is unavailable') })]);
    });
    it('service Add and Cancel preserve the existing form defaults', async () => {
        const data = await act({ kind: 'services.add', workspaceId: 'work' });
        expect(data.services?.adding).toMatchObject({ workspaceId: 'work', problems: [], consent: null });
        expect((await act({ kind: 'services.cancelForm' })).services?.adding).toBeNull();
    });
    it('invalid service forms retain their problems and create nothing', async () => {
        const data = await act({ kind: 'services.create', form: { ...serviceForm, major: '' }, consent: true });
        expect(data.services?.adding?.problems.length).toBeGreaterThan(0); expect(f.hosting.engines.list()).toEqual([]); expect(pulls()).toEqual([]);
    });
    it('an absent image asks for consent without pulling or creating a service', async () => {
        const data = await act({ kind: 'services.create', form: serviceForm, consent: false });
        expect(data.services?.adding?.consent).toMatchObject({ image: expect.stringContaining('postgres:17') });
        expect(f.hosting.engines.list()).toEqual([]); expect(pulls()).toEqual([]);
    });
    it('a consented service create uses the owned registry and starts through the real driver', async () => {
        const data = await act({ kind: 'services.create', form: serviceForm, consent: true });
        expect(data.services?.adding).toBeNull(); expect(data.services?.instances).toEqual([expect.objectContaining({ status: 'running' })]);
        expect(f.hosting.engines.list()).toHaveLength(1); expect(pulls()).toHaveLength(1);
    });
    it('making an engine version active changes the owned workspace choice', async () => {
        await f.seedEngine('17'); await f.seedEngine('16');
        await act({ kind: 'services.setActive', workspaceId: 'work', engine: 'postgres', version: '16' });
        expect(f.hosting.engines.list().filter(row => row.active).map(row => row.version)).toEqual(['16']);
    });
    it('using and detaching a service changes its real workspace selection', async () => {
        const engine = await f.seedEngine('17', 'shared');
        await act({ kind: 'services.detach', workspaceId: 'work', serviceId: engine.id });
        expect(f.hosting.engines.choices('work').find(choice => choice.kind === 'postgres')?.chosen ?? null).toBeNull();
        await act({ kind: 'services.use', workspaceId: 'work', serviceId: engine.id });
        expect(f.hosting.engines.choices('work').find(choice => choice.kind === 'postgres')?.chosen?.id).toBe(engine.id);
    });
    it('service Stop, Start and Remove keep their owned behavior and preserve data by default', async () => {
        const engine = await f.seedEngine();
        expect((await act({ kind: 'services.stop', serviceId: engine.id })).services?.instances[0]?.status).toBe('exited');
        expect((await act({ kind: 'services.start', serviceId: engine.id })).services?.instances[0]?.status).toBe('running');
        expect((await act({ kind: 'services.remove', serviceId: engine.id, deleteData: false })).services?.instances).toEqual([]);
        expect(f.hosting.engines.list()).toEqual([]); expect(f.dockerCalls.some(args => args[0] === 'volume')).toBe(false);
    });
    it('service logs are read only when asked, retained for that caller and hidden explicitly', async () => {
        const engine = await f.seedEngine(); await read(); expect(logCalls()).toEqual([]);
        const data = await act({ kind: 'services.logs', serviceId: engine.id, tail: 7 });
        expect(data.services?.logs).toMatchObject({ serviceId: engine.id, text: 'fixture engine output\n', tail: 7 });
        expect((await read()).services?.logs?.serviceId).toBe(engine.id); expect(logCalls()).toHaveLength(1);
        expect((await act({ kind: 'services.hideLogs' })).services?.logs).toBeNull(); expect(logCalls()).toHaveLength(1);
    });
    it('a service update previews the actual image and its cancellation clears that caller result', async () => {
        const engine = await f.seedEngine(); const before = pulls().length;
        const data = await act({ kind: 'services.update', serviceId: engine.id, consent: false });
        expect(data.services?.updating).toMatchObject({ kind: 'needs-consent', serviceId: engine.id, image: expect.stringContaining('postgres:17') });
        expect(pulls()).toHaveLength(before); expect((await act({ kind: 'services.cancelUpdate' })).services?.updating).toBeNull();
    });
    it('the host snapshot contains actual sites, front-door status and missing-input reasons', async () => {
        const site = await f.seedSite(); const data = await read();
        expect(data.hosting?.sites.map(row => row.id)).toContain(site.id);
        expect(data.hosting?.frontDoor).toEqual(f.hosting.externalFrontDoor);
        expect(data.hosting?.problems).toContain('fixture hosting input is missing');
    });
    it('trust steps and browser routes are derived from the owned hosting stack', async () => {
        await f.seedSite(); await f.hosting.trust.untrust('work'); await f.hosting.trust.refresh('work');
        const expected = trustSteps(f.hosting.trust.entries());
        expect(expected.map(row => row.workspaceId)).toContain('work');
        const data = await read(); expect(data.trust).toEqual(expected); expect(f.hosting.routes().length).toBeGreaterThan(0);
        expect(data.browser.routes).toEqual(f.hosting.routes());
    });
    it('site Add derives its defaults from the real folder and Cancel clears the form', async () => {
        const data = await act({ kind: 'hosting.addSite', workspaceId: 'work', repoPath: f.workspace });
        expect(data.hosting?.adding).toMatchObject({ workspaceId: 'work', repoPath: f.workspace, problems: [], defaults: { mode: 'proxy' } });
        expect((await act({ kind: 'hosting.cancelForm' })).hosting?.adding).toBeNull();
    });
    it('invalid site creation keeps validation problems without an envelope write', async () => {
        const before = await f.envelope(); const data = await act({ kind: 'hosting.createSite', workspaceId: 'work', repoPath: f.workspace, form: { ...siteForm, name: '' } });
        expect(data.hosting?.adding?.problems).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'name' })]));
        expect(await f.envelope()).toEqual(before); expect(f.hosting.sites.list()).toEqual([]);
    });
    it('creating a valid site persists it in the real workspace envelope', async () => {
        const data = await act({ kind: 'hosting.createSite', workspaceId: 'work', repoPath: f.workspace, form: siteForm });
        expect(data.hosting?.adding).toBeNull(); expect(f.hosting.sites.list()).toEqual([expect.objectContaining({ host: 'fixture.gen' })]);
        expect(JSON.stringify((await f.envelope()).sites)).toContain('fixture');
    });
    it('editing a site preserves validation and saves through the owned envelope', async () => {
        const site = await f.seedSite();
        expect((await act({ kind: 'hosting.editSite', siteId: site.id })).hosting?.editing).toMatchObject({ siteId: site.id, defaults: { name: 'fixture' } });
        const invalid = await act({ kind: 'hosting.updateSite', siteId: site.id, form: { ...siteForm, name: '' } });
        expect(invalid.hosting?.editing?.problems.length).toBeGreaterThan(0);
        const updated = await act({ kind: 'hosting.updateSite', siteId: site.id, form: { ...siteForm, hostPort: 43124 } });
        expect(updated.hosting?.editing).toBeNull(); expect(f.hosting.sites.get(site.id)?.port).toBe(43124);
    });
    it('site Stop, Start, Restart and Remove use the human lifecycle and durable declaration', async () => {
        const site = await f.seedSite();
        await act({ kind: 'hosting.stopSite', siteId: site.id }); expect(f.hosting.sites.get(site.id)?.state).toBe('stopped');
        await act({ kind: 'hosting.startSite', siteId: site.id }); expect(f.hosting.sites.get(site.id)?.state).toBe('external');
        await act({ kind: 'hosting.restartSite', siteId: site.id }); expect(f.hosting.sites.get(site.id)?.state).toBe('external');
        await act({ kind: 'hosting.removeSite', siteId: site.id }); expect(f.hosting.sites.list()).toEqual([]);
        expect(JSON.stringify((await f.envelope()).sites ?? {})).not.toContain('fixture');
    });
    it('opening a site without the callers own window refuses visibly rather than queuing success', async () => {
        const site = await f.seedSite();
        expect(await refusal({ kind: 'hosting.openSite', siteId: site.id })).toMatchObject({ ok: false, reason: 'this Genie has no browser to open a site in' });
        expect(f.invokeWindow).not.toHaveBeenCalled();
    });
    it('Trust and Sync hosts preserve host refusals while Retry uses the existing host operation', async () => {
        const expected = await f.hosting.trustCertificate(); expect(expected.ok).toBe(false);
        if (expected.ok) throw new Error('the preceding assertion failed');
        expect(await refusal({ kind: 'hosting.trustCertificate' })).toMatchObject({ ok: false, reason: expected.reason });
        const sync = f.hostingCalls.syncHosts, retry = f.hostingCalls.retryFrontDoor;
        expect(await refusal({ kind: 'hosting.syncHosts' })).toMatchObject({ ok: false, reason: 'fixture host has no bundled Caddy' });
        await act({ kind: 'hosting.retryFrontDoor' });
        expect(sync).toHaveBeenCalledTimes(1); expect(retry).toHaveBeenCalledTimes(1);
    });
    it('creating a kept process writes its real book and starts with the current workspace env', async () => {
        const data = await act({ kind: 'hosting.createProcess', workspaceId: 'work', workspacePath: f.workspace, name: 'fixture queue', command: 'fixture-worker', restart: 'never' });
        expect(data.hosting?.processes).toEqual([expect.objectContaining({ name: 'fixture queue', state: 'running', durable: true })]);
        expect(f.opened).toEqual([expect.objectContaining({ command: 'fixture-worker', cwd: f.workspace, env: { FIXTURE_SERVICE: 'owned' } })]);
        expect((await f.bookFile()).processes).toEqual([expect.objectContaining({ wanted: true })]);
    });
    it('a process folder outside its workspace is refused before anything starts or is kept', async () => {
        expect(await refusal({ kind: 'hosting.createProcess', workspaceId: 'work', workspacePath: f.workspace, name: 'fixture queue', command: 'fixture-worker', folder: '../outside', restart: 'never' }))
            .toMatchObject({ ok: false, reason: expect.stringContaining('inside the workspace') });
        expect(f.opened).toEqual([]); expect(f.book.list()).toEqual([]);
    });
    it('kept process Stop, Start, Restart and Remove preserve durable human intent', async () => {
        const process = await f.seedProcess();
        await act({ kind: 'hosting.stopProcess', processId: process.id }); expect((await f.bookFile()).processes[0]?.wanted).toBe(false);
        await act({ kind: 'hosting.startProcess', processId: process.id }); expect((await f.bookFile()).processes[0]?.wanted).toBe(true);
        await act({ kind: 'hosting.restartProcess', processId: process.id }); expect(f.opened).toHaveLength(3);
        await act({ kind: 'hosting.removeProcess', processId: process.id }); expect(f.book.list()).toEqual([]); expect((await f.bookFile()).processes).toEqual([]);
    });
    it('a process outside the kept book cannot be removed through the kept-process action', async () => {
        const row = f.supervisor.start({ id: 'site-owned', workspaceId: 'work', name: 'site process', command: 'fixture-server', cwd: f.workspace, restart: 'never' });
        expect(await refusal({ kind: 'hosting.removeProcess', processId: row.id })).toMatchObject({ ok: false, reason: expect.stringContaining('a site\'s process is removed with its site') });
        expect(f.supervisor.status(row.id)?.state).toBe('running');
    });
    it('scheduled processes are kept without starting and Pause, Enable and Run now use the owned clock', async () => {
        const created = await act({ kind: 'hosting.createProcess', workspaceId: 'work', workspacePath: f.workspace, name: 'fixture schedule', command: 'fixture-worker', restart: 'never', schedule: '*/5 * * * *' });
        const row = created.hosting?.processes.find(process => process.name === 'fixture schedule');
        expect(row).toMatchObject({ state: 'stopped', schedule: { enabled: true } }); expect(f.opened).toEqual([]);
        await act({ kind: 'hosting.pauseSchedule', processId: row!.id }); expect(f.book.list()[0]?.schedule?.enabled).toBe(false);
        await act({ kind: 'hosting.enableSchedule', processId: row!.id }); expect(f.book.list()[0]?.schedule?.enabled).toBe(true);
        await act({ kind: 'hosting.runScheduledNow', processId: row!.id }); expect(f.opened).toHaveLength(1);
    });
    it('a missing scheduled task retains its explicit refusal without starting anything', async () => {
        expect(await refusal({ kind: 'hosting.runScheduledNow', processId: 'missing' })).toMatchObject({ ok: false, reason: 'no scheduled task missing that you keep' });
        expect(f.opened).toEqual([]);
    });
    it('process rows keep bounded supervisor tails and omit workspaces hidden by the host', async () => {
        const row = await f.seedProcess(); f.print(Array.from({ length: 60 }, (_, index) => `fixture line ${index}\n`).join(''));
        const data = await read(), log = data.hosting?.processes.find(process => process.id === row.id)?.log;
        expect(log?.lines).toBe(40); expect(log?.text).toContain('fixture line 59'); expect(log?.text).not.toContain('fixture line 0\n');
        f.visible.clear(); expect((await read()).hosting?.processes).toEqual([]);
    });
    it('group two stays host authoritative with zero, one and two connected windows', async () => {
        const engine = await f.seedEngine(), site = await f.seedSite();
        for (const count of [0, 1, 2, 0]) { f.windows(count); const data = await read();
            expect(data.services?.instances[0]?.instance.id).toBe(engine.id); expect(data.hosting?.sites[0]?.id).toBe(site.id); }
        expect(f.invokeWindow).not.toHaveBeenCalled();
    });
    it('owned engine, site and process-book changes reach feature subscribers', async () => {
        const events = f.changes(), engine = await f.seedEngine(); await settleFeatures();
        expect(events.snapshots.at(-1)?.services?.instances[0]?.instance.id).toBe(engine.id);
        const site = await f.seedSite(); await settleFeatures(); expect(events.snapshots.at(-1)?.hosting?.sites[0]?.id).toBe(site.id);
        const process = await f.seedProcess(); await settleFeatures(); expect(events.snapshots.at(-1)?.hosting?.processes[0]?.id).toBe(process.id);
        expect(events.revisions.length).toBeGreaterThan(0);
    });
    it('supervisor output and front-door changes invalidate owned facts and unsubscribe ends delivery', async () => {
        const process = await f.seedProcess(), events = f.changes();
        f.print('live fixture output\n'); await settleFeatures();
        expect(events.snapshots.at(-1)?.hosting?.processes.find(row => row.id === process.id)?.log?.text).toContain('live fixture output');
        const before = events.revisions.length; f.frontChanged(); await settleFeatures(); expect(events.revisions.length).toBeGreaterThan(before);
        events.off(); const ended = events.revisions.length; f.print('after unsubscribe\n'); f.frontChanged(); await settleFeatures();
        expect(events.revisions).toHaveLength(ended);
    });
    it('CONTROL: the canonical host registry and inert Docker driver really create and report an engine', async () => {
        const engine = await f.seedEngine(); expect(f.hosting.engines.list()[0]?.id).toBe(engine.id);
        expect(await f.hosting.engineStatuses()).toEqual([expect.objectContaining({ status: 'running' })]); expect(pulls()).toHaveLength(1);
    });
    it('CONTROL: the canonical envelope site really persists and contributes a route', async () => {
        const site = await f.seedSite(); expect(f.hosting.sites.get(site.id)?.host).toBe('fixture.gen');
        expect(JSON.stringify((await f.envelope()).sites)).toContain('fixture'); expect(f.hosting.routes().map(route => route.host)).toContain('fixture.gen');
        await f.hosting.trust.untrust('work'); await f.hosting.trust.refresh('work');
        expect(trustSteps(f.hosting.trust.entries()).map(row => row.workspaceId)).toContain('work');
    });
    it('CONTROL: the real process book, supervisor and scheduler act through the inert PTY', async () => {
        const row = await f.seedProcess(); expect(f.opened).toHaveLength(1); expect(f.supervisor.status(row.id)?.state).toBe('running');
        f.print('control output\n'); expect(f.supervisor.readLog(row.id, 40)?.text).toContain('control output');
        await f.book.stop(row.id); expect(f.supervisor.status(row.id)?.state).toBe('stopped'); expect((await f.bookFile()).processes[0]?.wanted).toBe(false);
        const task = await f.book.create({ workspaceId: 'work', workspacePath: f.workspace, name: 'control schedule', command: 'fixture-worker', restart: 'never',
            schedule: { cron: '*/5 * * * *', kind: 'command' }, enabled: false });
        expect(f.opened).toHaveLength(1); expect(await f.scheduler.runNow(task.id)).toBe('started'); expect(f.opened).toHaveLength(2);
    });
});
