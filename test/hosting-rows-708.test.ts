import { describe, expect, it } from 'vitest';
import type { ServiceInstance } from '../src/core/services.js';
import { chooseEngines } from '../src/core/services.js';
import { engineChoiceActions, processActions, scheduledActions, serviceActions, siteActions, type RowAction, type RowActions } from '../src/renderer/components/hosting-rows.js';
import type { HostedSite } from '../src/renderer/features.js';
import { ICON_NAMES } from '../src/renderer/icons.js';

/**
 * HOSTING ROWS (Tynn #708): one line per row, the primary action as an icon button, everything else in a "⋯" menu with
 * the destructive actions LAST, in red, behind a confirm. This is the model of what each row offers; the components draw it.
 */

const ids = (a: readonly RowAction[]) => a.map((x) => x.id);
const proc = (over: Record<string, unknown>) => ({ id: 'p1', workspaceId: 'tynn', name: 'queue', state: 'running', pid: 1, exitCode: null, restarts: 0, since: 1, ...over }) as never;

/** The rules every row obeys, whatever it is. */
function lawful(a: RowActions): void {
    for (const x of [...a.primary, ...a.menu]) {
        expect(x.label.trim().length, `${x.id} has a label`).toBeGreaterThan(0);
        expect(x.icon.length, `${x.id} has an icon`).toBeGreaterThan(0);
        expect(x.label, `${x.id}: no internal ids in a label`).not.toMatch(/svc_|site_|p1\b/);
    }
    expect(a.primary.every((x) => !x.danger), 'a primary action is never the destructive one').toBe(true);
    const danger = a.menu.map((x) => x.danger === true);
    expect(danger, 'destructive actions come last').toEqual([...danger].sort((x, y) => Number(x) - Number(y)));
    for (const x of a.menu.filter((m) => m.danger)) expect(x.confirm, `${x.id} is confirmed`).toBeDefined();
}

describe('process rows', () => {
    it('a running kept process: Stop is the primary action; Restart waits in the menu', () => {
        const a = processActions(proc({ durable: true, command: 'php artisan queue:work' }));
        expect(ids(a.primary)).toEqual(['stop']);
        expect(ids(a.menu)).toEqual(['restart']);
        lawful(a);
    });
    it('a stopped kept process: Start is primary; Remove is last, red, confirmed', () => {
        const a = processActions(proc({ state: 'stopped', pid: null, durable: true }));
        expect(ids(a.primary)).toEqual(['start']);
        expect(ids(a.menu)).toEqual(['remove']);
        expect(a.menu[0]!.danger).toBe(true);
        expect(typeof a.menu[0]!.confirm).toBe('object');
        expect(a.menu[0]!.acts).toEqual([{ kind: 'hosting.removeProcess', processId: 'p1' }]);
        lawful(a);
    });
    it('a site’s own process is never offered Remove', () => {
        expect(ids(processActions(proc({ id: 'site:api', state: 'exited', pid: null, exitCode: 1 })).primary)).toEqual(['restart']);
        expect(processActions(proc({ id: 'site:api', state: 'exited', pid: null })).menu).toEqual([]);
        expect(ids(processActions(proc({ id: 'site:docs' })).menu)).toEqual(['restart']);
    });
    it('a service command (#633) offers only Stop while it runs and nothing after', () => {
        const run = processActions(proc({ commandRun: true }));
        expect(ids(run.primary)).toEqual(['stop']);
        expect(run.menu).toEqual([]);
        const done = processActions(proc({ commandRun: true, state: 'exited', pid: null }));
        expect([...done.primary, ...done.menu]).toEqual([]);
    });
    it('a scheduled task: Run now primary; Pause / Enable and Remove (red, last, not while running) in the menu', () => {
        const sched = (enabled: boolean, state = 'stopped') => proc({ state, durable: true, schedule: { kind: 'command', cron: '0 3 * * *', enabled, nextRunAt: null, lastRunAt: null, lastRunStatus: null } });
        const on = scheduledActions(sched(true));
        expect(ids(on.primary)).toEqual(['run-now']);
        expect(ids(on.menu)).toEqual(['pause', 'remove']);
        expect(ids(scheduledActions(sched(false)).menu)).toEqual(['enable', 'remove']);
        expect(ids(scheduledActions(sched(true, 'running')).menu)).toEqual(['pause']);
        lawful(on);
    });
});

describe('service rows', () => {
    const pg: ServiceInstance = { id: 'svc_pg', engine: 'postgres', version: '18', scope: { kind: 'dedicated', workspaceId: 'tynn' }, publishedPort: 5432, credentials: {}, active: true };
    const mailpit: ServiceInstance = { id: 'svc_m', engine: 'mailpit', version: '1.30', scope: { kind: 'shared' }, publishedPort: 4101, credentials: {}, active: true, publishedPorts: { ui: 4102 } };
    const o = { warning: false, logsOpen: false };

    it('a running engine: Stop is primary; Logs, Update image, then Remove and Remove-and-delete-data last, red, confirmed', () => {
        const a = serviceActions(pg, 'running', o);
        expect(ids(a.primary)).toEqual(['stop']);
        expect(ids(a.menu)).toEqual(['logs', 'update', 'remove', 'delete-data']);
        const [remove, del] = a.menu.slice(2);
        expect(remove!.danger && del!.danger).toBe(true);
        expect(typeof remove!.confirm).toBe('object');
        expect(JSON.stringify(remove!.confirm)).toMatch(/keep/i);
        expect(del!.confirm).toBe('inline');
        expect(remove!.acts).toEqual([{ kind: 'services.remove', serviceId: 'svc_pg', deleteData: false }]);
        lawful(a);
    });
    it('a stopped engine: Start is primary', () => {
        expect(ids(serviceActions(pg, 'exited', o).primary)).toEqual(['start']);
    });
    it('a running Mailpit: Open inbox is a primary action beside Stop, and it opens Genie’s browser on the inbox', () => {
        const a = serviceActions(mailpit, 'running', o);
        expect(ids(a.primary)).toEqual(['open-inbox', 'stop']);
        expect(a.primary[0]!.navigate).toBe('genie://browser');
        expect(a.primary[0]!.acts).toEqual([{ kind: 'browser.navigate', url: 'https://mail.gen/' }]);
        lawful(a);
    });
    it('a version that is not active offers Make active first in the menu; an open log says Refresh logs', () => {
        const a = serviceActions({ ...pg, id: 'svc_pg17', version: '17', active: false }, 'running', { warning: true, logsOpen: true });
        expect(ids(a.menu)[0]).toBe('make-active');
        expect(a.menu.find((m) => m.id === 'logs')!.label).toBe('Refresh logs');
        expect(a.menu[0]!.acts).toEqual([{ kind: 'services.use', workspaceId: 'tynn', serviceId: 'svc_pg17' }]);
    });
    it('Update image is off while Docker is not running', () => {
        expect(serviceActions(pg, 'docker-not-running', o).menu.find((m) => m.id === 'update')!.disabled).toBe(true);
        expect(serviceActions(pg, 'running', o).menu.find((m) => m.id === 'update')!.disabled).toBeFalsy();
    });
});

describe('site rows', () => {
    const site = (over: Partial<HostedSite>) => ({ id: 'site_web', name: 'web', host: 'web.example.gen', workspaceId: 'acme', repoPath: '/w', serve: { mode: 'proxy' }, port: null, state: 'stopped', processIds: [], problem: null, ...over }) as HostedSite;

    it('running: Open and Stop are icon buttons; Restart, Edit and Remove (red, last, confirmed) are in the menu', () => {
        const a = siteActions(site({ state: 'running', port: 4101, processIds: ['site_web'] }), { editing: false });
        expect(ids(a.primary)).toEqual(['open', 'stop']);
        expect(ids(a.menu)).toEqual(['restart', 'edit', 'remove']);
        const remove = a.menu[2]!;
        expect(remove.danger).toBe(true);
        expect(typeof remove.confirm === 'object' && remove.confirm.body).toMatch(/Remove web\.example\.gen\? It is stopped and taken out of this workspace’s project\.json\. Its folder and files are not touched\./);
        expect(remove.acts).toEqual([{ kind: 'hosting.removeSite', siteId: 'site_web' }]);
        lawful(a);
    });
    it('external: no Restart, because Genie runs no process for it', () => {
        expect(ids(siteActions(site({ state: 'external', port: 5173 }), { editing: false }).menu)).toEqual(['edit', 'remove']);
    });
    it('stopped: Start is primary', () => {
        const a = siteActions(site({}), { editing: false });
        expect(ids(a.primary)).toEqual(['start']);
        expect(ids(a.menu)).toEqual(['edit', 'remove']);
    });
    it('failed with a process: Retry is primary', () => {
        expect(ids(siteActions(site({ state: 'failed', processIds: ['site_web'] }), { editing: false }).primary)).toEqual(['retry']);
    });
    it('still starting past the first window: Retry beside Stop, both icon buttons', () => {
        expect(ids(siteActions(site({ state: 'starting', step: 'slow' } as never), { editing: false }).primary)).toEqual(['retry', 'stop']);
        expect(ids(siteActions(site({ state: 'starting', step: 'answering' } as never), { editing: false }).primary)).toEqual(['stop']);
    });
    it('while its form is open there is no second Edit; an unservable site offers nothing', () => {
        expect(ids(siteActions(site({ state: 'running' }), { editing: true }).menu)).not.toContain('edit');
        const none = siteActions(site({ state: 'unservable', serve: null }), { editing: false });
        expect([...none.primary, ...none.menu]).toEqual([]);
    });
});

describe('In use rows', () => {
    const WS = 'example';
    const own: ServiceInstance = { id: 'svc_own', engine: 'postgres', version: '17', scope: { kind: 'dedicated', workspaceId: WS }, publishedPort: 1, credentials: {}, active: true };
    const shared = (detached = false): ServiceInstance => ({ id: 'svc_shared', engine: 'postgres', version: '17', scope: { kind: 'shared' }, publishedPort: 2, credentials: {}, active: true, slices: { [WS]: { identifier: 'ws', password: 'y', active: !detached } }, ...(detached ? { detached: [WS] } : {}) });
    const label = (i: ServiceInstance) => `${i.engine} ${i.version}${i.scope.kind === 'shared' ? ' · shared' : ''}`;

    it('the shared engine in use is detached from the menu, and the detach keeps the data', () => {
        const [c] = chooseEngines([shared()], WS);
        const m = engineChoiceActions(WS, c!, label);
        expect(ids(m)).toEqual(['detach']);
        expect(m[0]!.acts).toEqual([{ kind: 'services.detach', workspaceId: WS, serviceId: 'svc_shared' }]);
    });
    it('another candidate is offered as Use, and a detached one as Attach', () => {
        const [c] = chooseEngines([shared(), own], WS);
        expect(engineChoiceActions(WS, c!, label).map((x) => x.label)).toEqual(['Use postgres 17 · shared']);
        const [d] = chooseEngines([shared(true)], WS);
        expect(engineChoiceActions(WS, d!, label).map((x) => x.label)).toEqual(['Attach postgres 17 · shared']);
    });
});

describe('icons', () => {
    it('every icon a row names is registered, or it draws as a blank gap (icons are named in data here, which test/icons.test.ts cannot scan)', () => {
        const pg: ServiceInstance = { id: 'svc_pg', engine: 'postgres', version: '18', scope: { kind: 'dedicated', workspaceId: 'tynn' }, publishedPort: 1, credentials: {}, active: false };
        const mailpit: ServiceInstance = { id: 'svc_m', engine: 'mailpit', version: '1', scope: { kind: 'shared' }, publishedPort: 1, credentials: {}, active: true, publishedPorts: { ui: 2 } };
        const site = (state: string, extra: object = {}) => ({ id: 's', name: 'w', host: 'w.gen', workspaceId: 'a', repoPath: '/w', serve: { mode: 'proxy' }, port: 1, state, processIds: ['s'], problem: null, ...extra }) as HostedSite;
        const sched = (enabled: boolean) => proc({ state: 'stopped', durable: true, schedule: { kind: 'command', cron: '0 3 * * *', enabled, nextRunAt: null } });
        const all: RowActions[] = [
            serviceActions(pg, 'running', { warning: true, logsOpen: true }), serviceActions(mailpit, 'exited', { warning: false, logsOpen: false }),
            siteActions(site('running'), { editing: false }), siteActions(site('failed'), { editing: false }), siteActions(site('starting', { step: 'slow' }), { editing: false }), siteActions(site('stopped'), { editing: false }),
            processActions(proc({ durable: true })), processActions(proc({ durable: true, state: 'stopped' })), processActions(proc({ state: 'exited' })),
            scheduledActions(sched(true)), scheduledActions(sched(false)),
            { primary: [], menu: engineChoiceActions('w', chooseEngines([{ ...mailpit, slices: { w: { identifier: 'w', password: 'p', active: true } } }, pg], 'w')[0]!, (i) => i.engine) },
        ];
        const named = new Set(all.flatMap((a) => [...a.primary, ...a.menu].map((x) => x.icon)));
        expect(named.size).toBeGreaterThan(8);
        expect([...named].filter((n) => !ICON_NAMES.includes(n))).toEqual([]);
    });
});
