import type { EngineStatusView } from '../core/engine-reconcile.js';
import { serviceFormDefaults } from '../core/forms.js';
import type { FeatureAction, FeatureData, HostedSite, ServiceAdding } from '../renderer/features.js';
import type { FeaturePorts, FeatureState } from './feature-ipc.js';
import type { HostingApi } from './hosting-host.js';
import type { HostedProcess } from './process-book.js';
import type { SitePin } from './php-versions.js';
import {
    createService, createSite, detachService, openSite, removeService, removeSite, restartSite, serviceLogs,
    setActiveService, siteDefaultsIn, siteEditTarget, siteLogs, startService, startSite, stopService, stopSite,
    updateService, updateSite, useService, type HostingServices,
} from './hosting-actions.js';

/** The same hosting business surface for the canonical host and the window's replica. */
export interface HostingFeatureServices extends HostingServices, Pick<HostingApi,
    'externalFrontDoor' | 'hostingProblems' | 'trustCertificate' | 'syncHosts' | 'retryFrontDoor'> {
    trustSteps(): NonNullable<FeatureData['trust']>;
    workspaceVisible(workspaceId: string): boolean;
}

export type HostingFeaturePorts = Pick<FeaturePorts, 'processes' | 'processScheduler' | 'openInBrowser'
    | 'engineStatusWaitMs' | 'onEngineStatusesLate'> & {
    readonly toolchain?: Pick<NonNullable<FeaturePorts['toolchain']>, 'php'>;
};

/** How much of a process's log rides each snapshot: the end of it. All of it is the agents' `processes logs`. */
export const ROW_LOG_LINES = 40;

/** Each site with the end of its processes' output — the same read as the agents' `sites logs` (hosting-actions.ts). */
function sitesWithLogs(services: HostingFeatureServices): HostedSite[] {
    return services.sites.list().map((site) => {
        const logs = siteLogs(services, site.id, ROW_LOG_LINES).filter((l) => l.lines > 0);
        return logs.length > 0 ? { ...site, logs } : site;
    });
}

function withLogTails(services: HostingFeatureServices, rows: readonly HostedProcess[]): HostedProcess[] {
    return rows.map((row) => {
        const log = services.supervisor.readLog(row.id, ROW_LOG_LINES);
        return log && log.lines > 0 ? { ...row, log } : row;
    });
}

/**
 * A SNAPSHOT NEVER WAITS ON A SLOW DOCKER FOR LONG (genie#1393). Every snapshot (a click's answer, every push) read the
 * engines' statuses from Docker first: `docker version`, then one `docker container inspect` per engine, each allowed
 * 20 s. So the Hosting tab's state, built before that read, reached the window only when Docker answered, slowest exactly
 * when Genie has just started a dozen sites and every supervisor transition asked for another snapshot. Now: one read at
 * a time (a snapshot asked for while one is in flight joins it), and a snapshot waits at most this long for it before it
 * goes out with the LAST read Docker gave; when the read lands, `onEngineStatusesLate` asks for a fresh push.
 */
export const ENGINE_STATUS_WAIT_MS = 1_500;
const engineReads = new WeakMap<object, { last?: EngineStatusView[]; inFlight?: Promise<EngineStatusView[]> }>();

async function engineStatusesWithin(services: HostingFeatureServices, ports: HostingFeaturePorts): Promise<EngineStatusView[]> {
    let entry = engineReads.get(services);
    if (!entry) { entry = {}; engineReads.set(services, entry); }
    const e = entry;
    const read = e.inFlight ?? (e.inFlight = services.engineStatuses().then(
        (views) => { e.last = views; return views; },
    ).finally(() => { delete e.inFlight; }));
    const prior = e.last;
    if (prior === undefined) return read;
    const late = Symbol('late');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const first = await Promise.race([read.catch(() => late), new Promise<typeof late>((r) => { timer = setTimeout(() => r(late), ports.engineStatusWaitMs ?? ENGINE_STATUS_WAIT_MS); })]);
    clearTimeout(timer);
    if (first !== late) return first as EngineStatusView[];
    // Only when Docker's answer CHANGES what was shown: a push builds a snapshot, which reads Docker again, so a Docker
    // that is merely slow would otherwise push forever.
    read.then((views) => { if (JSON.stringify(views) !== JSON.stringify(prior)) ports.onEngineStatusesLate?.(); }, () => {});
    return prior;
}

/** Every site's PHP pin — what the PHP versions list shows as "used by" and a removal is refused against. */
export function sitePins(services: Pick<HostingFeatureServices, 'sites'>): SitePin[] {
    return services.sites.list().flatMap((s) => (s.serve?.mode === 'php' && s.serve.version ? [{ host: s.host, pin: s.serve.version }] : []));
}

/** The Add-a-site form's PHP version choices: the versions Genie manages, newest first (none wired = no choices, the PATH PHP). */
async function phpChoices(services: HostingFeatureServices, ports: HostingFeaturePorts): Promise<{ phpVersions?: string[] }> {
    const php = ports.toolchain?.php;
    if (!php) return {};
    return { phpVersions: (await php.list(sitePins(services))).managed.map((m) => m.version) };
}

/** Owned hosting facts plus the requesting view's forms and log selection. No extra store or OS graph. */
export async function hostingFeatureSnapshot(services: HostingFeatureServices, state: FeatureState, ports: HostingFeaturePorts = {},
    timed: <T>(part: string, work: () => Promise<T>) => Promise<T> = (_part, work) => work(),
): Promise<Pick<FeatureData, 'trust' | 'hosting' | 'services' | 'browser'>> {
    return {
        trust: services.trustSteps(),
        // Stopped kept processes remain listed, with the supervisor's bounded output tail.
        hosting: { sites: sitesWithLogs(services), processes: withLogTails(services, ports.processes ? ports.processes.list().filter((p) => services.workspaceVisible(p.workspaceId)) : []), adding: state.siteAdding ?? null, editing: state.siteEditing ?? null, frontDoor: services.externalFrontDoor, problems: services.hostingProblems() },
        // The first status read is real; a later slow read uses the last answer until its change invalidates it.
        services: { instances: await timed('engines', () => engineStatusesWithin(services, ports)), adding: state.serviceAdding ?? null, logs: state.serviceLogs ?? null, ...(state.serviceUpdating !== undefined ? { updating: state.serviceUpdating } : {}) },
        browser: { url: state.browserUrl ?? null, routes: services.routes(), canGoBack: state.browserCanGoBack ?? false, canGoForward: state.browserCanGoForward ?? false },
    };
}

/** Apply this group through the existing hosting actions, as the person; unknown families are left to their owner. */
export async function applyHostingFeatureAction(services: HostingFeatureServices, action: FeatureAction, state: FeatureState, next: FeatureState, ports: HostingFeaturePorts = {}): Promise<boolean> {
    switch (action.kind) {
        case 'hosting.addSite':
            // Named Genie 1's way, `<folder>.<workspace>` — the agents' `sites add` and `detect` get the same defaults.
            next.siteAdding = { workspaceId: action.workspaceId, repoPath: action.repoPath, defaults: await siteDefaultsIn(services, action.workspaceId, action.repoPath), problems: [], ...(await phpChoices(services, ports)) };
            next.siteEditing = null;
            break;
        case 'hosting.cancelForm':
            next.siteAdding = null;
            next.siteEditing = null;
            break;
        case 'hosting.editSite': {
            // The form opens on the site as it is declared now; a site that cannot be edited says why (thrown).
            const target = siteEditTarget(services, action.siteId);
            // The PHP version choices Add offers, so the form shows the site's pin and saving it never drops it.
            next.siteEditing = { siteId: action.siteId, host: target.site.host, defaults: target.form, problems: [], ...(await phpChoices(services, ports)) };
            next.siteAdding = null;
            break;
        }
        case 'hosting.updateSite': {
            // The same call an agent's `sites update` makes (hosting-actions.ts): the Add form's validation, one envelope write.
            const r = await updateSite(services, { siteId: action.siteId, form: action.form, person: true });
            if (r.kind === 'problems') {
                const open = state.siteEditing ?? { siteId: action.siteId, host: services.sites.get(action.siteId)?.host ?? action.siteId, defaults: action.form, problems: [], ...(await phpChoices(services, ports)) };
                next.siteEditing = { ...open, defaults: action.form, problems: r.problems };
                break;
            }
            next.siteEditing = null;
            break;
        }
        case 'hosting.restartSite':
            // The same call an agent's `sites restart` makes: stopped and started again, and a remembered Stop lifted.
            await restartSite(services, action.siteId, { person: true });
            break;
        case 'hosting.openSite': {
            // The same call an agent's `sites open` makes: checked against the front door's routes, then shown in Genie's browser.
            if (!ports.openInBrowser) throw new Error('this Genie has no browser to open a site in');
            next.browserUrl = (await openSite(services, action.siteId, ports.openInBrowser)).url;
            break;
        }
        case 'hosting.createSite': {
            // The same call an agent's `sites add` makes (hosting-actions.ts): one validation, one env, one envelope write.
            const r = await createSite(services, { workspaceId: action.workspaceId, repoPath: action.repoPath, form: action.form });
            if (r.kind === 'problems') {
                // A refused submit is DATA for the form: shown beside the fields, where it was caused.
                const open = state.siteAdding ?? { workspaceId: action.workspaceId, repoPath: action.repoPath, defaults: await siteDefaultsIn(services, action.workspaceId, action.repoPath), problems: [] };
                next.siteAdding = { ...open, problems: r.problems };
                break;
            }
            next.siteAdding = null;
            break;
        }
        case 'hosting.trustCertificate': {
            const r = await services.trustCertificate();
            if (!r.ok) throw new Error(r.reason);
            break;
        }
        case 'hosting.syncHosts':
            await services.syncHosts();
            break;
        case 'hosting.retryFrontDoor':
            // The person's Try again on a front door whose port another process held: asked again; started when free.
            await services.retryFrontDoor();
            break;
        case 'hosting.startSite':
            // The person's Start: serves a listed site that is not running, and lifts a remembered Stop.
            await startSite(services, action.siteId, { person: true });
            break;
        case 'hosting.stopSite':
            // The person's Stop, remembered on this machine: the next launch leaves it down.
            await stopSite(services, action.siteId);
            break;
        case 'hosting.removeSite':
            // Removed from the workspace's envelope too, so it does not come back on the next launch.
            await removeSite(services, action.siteId);
            break;
        // A process the person keeps goes through the book, so their start/stop is written down and
        // holds through a restart; a site's or the front door's process is the supervisor's alone.
        case 'hosting.restartProcess':
            if (ports.processes?.owns(action.processId)) await ports.processes.restart(action.processId);
            else if (!services.supervisor.restart(action.processId)) throw new Error(`no process ${action.processId}`);
            break;
        case 'hosting.stopProcess':
            if (ports.processes?.owns(action.processId)) await ports.processes.stop(action.processId);
            else if (!services.supervisor.stop(action.processId)) throw new Error(`no process ${action.processId}`);
            break;
        case 'hosting.createProcess': {
            const book = ports.processes;
            if (!book) throw new Error('no process book is wired into this Genie; a background process cannot be kept');
            // With a schedule it is a SCHEDULED TASK (genie#1204, Genie 1's form): kept, enabled, fired by its schedule.
            const cron = action.schedule?.trim();
            await book.create({ workspaceId: action.workspaceId, workspacePath: action.workspacePath, name: action.name, command: action.command, folder: action.folder, restart: action.restart, ...(cron ? { schedule: { cron, kind: 'command' as const }, enabled: true } : {}) });
            break;
        }
        case 'hosting.runScheduledNow': {
            if (!ports.processes?.owns(action.processId)) throw new Error(`no scheduled task ${action.processId} that you keep`);
            if (!ports.processScheduler) throw new Error('this Genie runs no scheduled tasks');
            await ports.processScheduler.runNow(action.processId);
            break;
        }
        case 'hosting.enableSchedule':
            if (!ports.processes?.owns(action.processId)) throw new Error(`no scheduled task ${action.processId} that you keep`);
            await ports.processes.enableSchedule(action.processId);
            break;
        case 'hosting.pauseSchedule':
            if (!ports.processes?.owns(action.processId)) throw new Error(`no scheduled task ${action.processId} that you keep`);
            await ports.processes.pauseSchedule(action.processId);
            break;
        case 'hosting.startProcess':
            if (!ports.processes?.owns(action.processId)) throw new Error(`no background process ${action.processId} that you keep`);
            await ports.processes.start(action.processId);
            break;
        case 'hosting.removeProcess':
            // A site's process goes with its site; only one the person keeps is removed here.
            if (!ports.processes?.owns(action.processId)) throw new Error(`no background process ${action.processId} that you keep; a site's process is removed with its site`);
            await ports.processes.remove(action.processId);
            break;
        case 'services.add':
            next.serviceAdding = { workspaceId: action.workspaceId, defaults: serviceFormDefaults({ workspaceId: action.workspaceId }), problems: [], consent: null };
            break;
        case 'services.cancelForm':
            next.serviceAdding = null;
            break;
        case 'services.create': {
            const open: ServiceAdding = state.serviceAdding ?? { workspaceId: action.form.workspaceId, defaults: action.form, problems: [], consent: null };
            // The same call an agent's `services add` makes (hosting-actions.ts); for an agent, the person's approval is the consent.
            const r = await createService(services, action.form, action.consent);
            if (r.kind === 'problems') {
                next.serviceAdding = { ...open, problems: r.problems, consent: null };
                break;
            }
            if (r.kind === 'needs-consent') {
                // The pull is a download the person should know about: the form stays open, ASKING, with the image named.
                next.serviceAdding = { ...open, problems: [], consent: { image: r.image, note: r.note, form: action.form } };
                break;
            }
            next.serviceAdding = null;
            break;
        }
        case 'services.setActive':
            await setActiveService(services, action.workspaceId, action.engine, action.version);
            break;
        case 'services.use':
            // The PERSON's choice, from the Services tab: no approval (an agent's `use` waits for this person's).
            await useService(services, action.workspaceId, action.serviceId);
            break;
        case 'services.detach':
            await detachService(services, action.workspaceId, action.serviceId);
            break;
        case 'services.start':
            await startService(services, action.serviceId);
            break;
        case 'services.stop':
            await stopService(services, action.serviceId);
            break;
        case 'services.update': {
            const previous = state.serviceUpdating?.serviceId === action.serviceId ? state.serviceUpdating : null;
            const r = await updateService(services, action.serviceId, { ...action, ...(previous ? { expectedImage: previous.image, approvedDependents: previous.dependents } : {}) });
            next.serviceUpdating = r.kind === 'needs-consent' ? r : null;
            break;
        }
        case 'services.cancelUpdate':
            next.serviceUpdating = null;
            break;
        case 'services.remove':
            // A delete-data acts for `workspaceId` (the Services tab sends the engine's sole data holder, core/service-tenancy.ts);
            // refused, with the other holders named, while anyone else keeps data in it.
            await removeService(services, action.serviceId, { deleteData: action.deleteData, ...(action.workspaceId ? { workspaceId: action.workspaceId } : {}) });
            if (state.serviceLogs?.serviceId === action.serviceId) next.serviceLogs = null;
            break;
        case 'services.logs':
            // Read when asked — never on every snapshot: `docker logs` is a call per engine, and a log is looked at, not watched.
            next.serviceLogs = { serviceId: action.serviceId, ...(await serviceLogs(services, action.serviceId, action.tail)) };
            break;
        case 'services.hideLogs':
            next.serviceLogs = null;
            break;
        default: return false;
    }
    return true;
}
