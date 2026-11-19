import type { EngineChoice, ServiceInstance } from '../../core/services.js';
import { mailpitInboxUrl } from '../../core/mailpit-name.js';
import type { FeatureAction, FeatureData, HostedSite } from '../features.js';

/**
 * WHAT EACH HOSTING ROW OFFERS (Tynn #708). A row is one line: the primary action as an icon button, everything else in
 * a "⋯" menu, the destructive actions LAST, in red, behind a confirm. These functions decide which action is which; the
 * components (RowMenu.tsx, FeatureSurfaces.tsx) only draw and send them. Plain data, so it is tested without a screen.
 *
 * A label is the words a person reads on the menu entry or in the icon button's tooltip. It never carries an internal id.
 */

export interface RowConfirm {
    readonly title: string;
    readonly body: string;
    readonly confirmLabel: string;
}

export interface RowAction {
    readonly id: string;
    readonly label: string;
    /** A react-fancy icon slug. */
    readonly icon: string;
    /** What pressing it sends, in order. Empty for an action the row handles itself (`confirm: 'inline'`). */
    readonly acts: readonly FeatureAction[];
    /** A surface to bring up first (Open inbox shows Genie's browser, then navigates it). */
    readonly navigate?: string;
    readonly danger?: boolean;
    /** `object`: the menu asks in a dialog before sending. `'inline'`: the row draws its own, more specific confirmation. */
    readonly confirm?: RowConfirm | 'inline';
    readonly disabled?: boolean;
}

export interface RowActions {
    /** Icon buttons on the line itself. */
    readonly primary: readonly RowAction[];
    /** The "⋯" menu, destructive entries last. */
    readonly menu: readonly RowAction[];
}

type ProcessView = NonNullable<FeatureData['hosting']>['processes'][number];

const NONE: RowActions = { primary: [], menu: [] };

/** Safe/neutral entries first, destructive ones after them, whatever order the caller listed them in. */
function dangerLast(menu: readonly RowAction[]): readonly RowAction[] {
    return [...menu.filter((m) => !m.danger), ...menu.filter((m) => m.danger)];
}

export function processActions(p: ProcessView): RowActions {
    const up = p.state === 'running' || p.state === 'restarting';
    const stop: RowAction = { id: 'stop', label: 'Stop', icon: 'square', acts: [{ kind: 'hosting.stopProcess', processId: p.id }] };
    // A service command (#633) is a one-shot run: it may be stopped while it runs, never restarted, started or removed.
    if (p.commandRun) return up ? { primary: [stop], menu: [] } : NONE;
    const restart: RowAction = { id: 'restart', label: 'Restart', icon: 'rotate-cw', acts: [{ kind: 'hosting.restartProcess', processId: p.id }] };
    const start: RowAction = { id: 'start', label: 'Start', icon: 'play', acts: [{ kind: 'hosting.startProcess', processId: p.id }] };
    const remove: RowAction = {
        id: 'remove', label: 'Remove', icon: 'trash-2', danger: true,
        acts: [{ kind: 'hosting.removeProcess', processId: p.id }],
        confirm: { title: `Remove ${p.name}?`, body: `${p.name} is taken off this workstation’s kept processes and will not come back after a restart.`, confirmLabel: 'Remove' },
    };
    if (up) return { primary: [stop], menu: [restart] };
    // Not running: a kept process starts and may be removed; one a site owns can only be restarted and goes with its site.
    return p.durable ? { primary: [start], menu: [remove] } : { primary: [restart], menu: [] };
}

export function scheduledActions(p: ProcessView): RowActions {
    const s = p.schedule!;
    const up = p.state === 'running' || p.state === 'restarting';
    const menu: RowAction[] = [
        s.enabled
            ? { id: 'pause', label: 'Pause schedule', icon: 'pause', acts: [{ kind: 'hosting.pauseSchedule', processId: p.id }] }
            : { id: 'enable', label: 'Enable schedule', icon: 'calendar-check', acts: [{ kind: 'hosting.enableSchedule', processId: p.id }] },
    ];
    if (!up) {
        menu.push({
            id: 'remove', label: 'Remove', icon: 'trash-2', danger: true,
            acts: [{ kind: 'hosting.removeProcess', processId: p.id }],
            confirm: { title: `Remove ${p.name}?`, body: `${p.name} and its schedule are removed. It will not run again.`, confirmLabel: 'Remove' },
        });
    }
    return {
        primary: [{ id: 'run-now', label: 'Run now', icon: 'play', acts: [{ kind: 'hosting.runScheduledNow', processId: p.id }] }],
        menu: dangerLast(menu),
    };
}

/** The engine as a person names it: "postgres (pgvector) 18", a custom one "name 1 · a redis". */
export function engineName(i: ServiceInstance): string {
    return `${i.engine}${i.variant ? ` (${i.variant})` : ''} ${i.version}${i.kind ? ` · a ${i.kind}` : ''}`;
}

export function serviceActions(i: ServiceInstance, status: string, o: { warning: boolean; logsOpen: boolean }): RowActions {
    const inbox = mailpitInboxUrl(i);
    const primary: RowAction[] = [];
    if (inbox) primary.push({ id: 'open-inbox', label: 'Open inbox', icon: 'inbox', navigate: 'genie://browser', acts: [{ kind: 'browser.navigate', url: inbox }] });
    primary.push(status === 'running'
        ? { id: 'stop', label: 'Stop', icon: 'square', acts: [{ kind: 'services.stop', serviceId: i.id }] }
        : { id: 'start', label: 'Start', icon: 'play', acts: [{ kind: 'services.start', serviceId: i.id }] });
    const menu: RowAction[] = [];
    if (o.warning && i.scope.kind === 'dedicated') {
        menu.push({ id: 'make-active', label: 'Make active', icon: 'check', acts: [{ kind: 'services.use', workspaceId: i.scope.workspaceId, serviceId: i.id }] });
    }
    menu.push({ id: 'logs', label: o.logsOpen ? 'Refresh logs' : 'Logs', icon: 'scroll-text', acts: [{ kind: 'services.logs', serviceId: i.id }] });
    menu.push({
        id: 'update', label: 'Update image…', icon: 'refresh-cw', acts: [{ kind: 'services.update', serviceId: i.id }],
        ...(status === 'docker-not-running' || status === 'absent' || status === 'unknown' ? { disabled: true } : {}),
    });
    menu.push({
        id: 'remove', label: 'Remove, keep data', icon: 'trash-2', danger: true,
        acts: [{ kind: 'services.remove', serviceId: i.id, deleteData: false }],
        confirm: { title: `Remove ${engineName(i)}?`, body: 'This removes the engine but keeps its data volume. Nothing is deleted, and adding the engine again picks the data back up.', confirmLabel: 'Remove, keep data' },
    });
    menu.push({ id: 'delete-data', label: 'Remove and delete data…', icon: 'trash-2', danger: true, acts: [], confirm: 'inline' });
    return { primary, menu: dangerLast(menu) };
}

export function siteActions(s: HostedSite, o: { editing: boolean }): RowActions {
    if (s.state === 'unservable') return NONE;
    const id = s.id;
    const up = s.state === 'running' || s.state === 'restarting' || s.state === 'external';
    const starting = s.state === 'starting';
    const down = (s.state === 'failed' || s.state === 'exited') && s.processIds.length > 0;
    const open: RowAction = { id: 'open', label: 'Open', icon: 'external-link', acts: [{ kind: 'hosting.openSite', siteId: id }] };
    const stop: RowAction = { id: 'stop', label: 'Stop', icon: 'square', acts: [{ kind: 'hosting.stopSite', siteId: id }] };
    const retry: RowAction = { id: 'retry', label: 'Retry', icon: 'rotate-ccw', acts: [{ kind: 'hosting.restartSite', siteId: id }] };
    const restart: RowAction = { id: 'restart', label: 'Restart', icon: 'rotate-cw', acts: [{ kind: 'hosting.restartSite', siteId: id }] };
    const start: RowAction = { id: 'start', label: 'Start', icon: 'play', acts: [{ kind: 'hosting.startSite', siteId: id }] };
    const edit: RowAction = { id: 'edit', label: 'Edit', icon: 'pencil', acts: [{ kind: 'hosting.editSite', siteId: id }] };
    const remove: RowAction = {
        id: 'remove', label: 'Remove', icon: 'trash-2', danger: true,
        acts: [{ kind: 'hosting.removeSite', siteId: id }],
        confirm: { title: `Remove ${s.host}?`, body: `Remove ${s.host}? It is stopped and taken out of this workspace’s project.json. Its folder and files are not touched.`, confirmLabel: 'Remove site' },
    };
    const primary: RowAction[] = [];
    const menu: RowAction[] = [];
    if (up) {
        primary.push(open, stop);
        if (s.state !== 'external') menu.push(restart);
    } else if (down) {
        primary.push(retry);
        if (s.state === 'failed') menu.push(stop);
    } else if (starting) {
        // Still starting past the first window: Retry beside Stop, as before.
        if (s.step === 'slow') primary.push(retry);
        primary.push(stop);
    } else {
        primary.push(start);
    }
    if (!o.editing) menu.push(edit);
    menu.push(remove);
    return { primary, menu: dangerLast(menu) };
}

/** The menu of one "In use" row: another engine to use or attach, and detaching the shared one in use (its data is kept). */
export function engineChoiceActions(workspaceId: string, c: EngineChoice, label: (i: ServiceInstance) => string): readonly RowAction[] {
    const out: RowAction[] = c.candidates
        .filter((x) => x.instance.id !== c.chosen?.id)
        .map((x) => ({
            id: `use-${x.instance.id}`,
            label: `${x.detached ? 'Attach' : 'Use'} ${label(x.instance)}`,
            icon: x.detached ? 'link' : 'check',
            acts: [{ kind: 'services.use', workspaceId, serviceId: x.instance.id }] as const,
        }));
    if (c.chosen && c.chosen.scope.kind === 'shared') {
        out.push({ id: 'detach', label: 'Detach, keep its data', icon: 'unlink', acts: [{ kind: 'services.detach', workspaceId, serviceId: c.chosen.id }] });
    }
    return out;
}
