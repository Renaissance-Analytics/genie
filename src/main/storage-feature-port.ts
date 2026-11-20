import { formatBytes, type StorageFailure, type StorageProgress, type StorageView, type TrashApproval } from '../core/workspace-storage.js';
import type { FeaturePorts } from './feature-ipc.js';
import type { ChatFile, StorageProblem, StorageProgressEvent, WorkspaceStorage } from './workspace-storage-host.js';

/**
 * THE HOST'S STORAGE ACTIONS (Tynn #697; made to say what they do in Tynn #947). The Storage tab's Move to .trash, Clean
 * up, Restore and Empty trash arrive as `features.act` (the one protocol, owner-only: main/remote-host.ts) and end here.
 *
 * Tynn #947, from the owner's beta.65: Move to .trash on 641 items and Empty trash showed nothing for twenty minutes and
 * genie-host.log had no line about either. So:
 *  - A Move or an Empty STARTS here and the action answers at once; the work runs on its own, never inside the caller's
 *    feature queue (where an Empty waited, unseen, behind the Move). The view says how far it is after every item.
 *  - It ends with a result in words, and each item it did not move or delete is named with the reason.
 *  - Each start, each item's failure, each result and each refusal is a line in the host log.
 *  - One Move or Empty at a time per workspace; another while it runs is refused in words, never queued unseen.
 *  - Work that throws is said in the view and the log, never swallowed.
 */
export interface StorageFeatureDeps {
    readonly storage: Pick<WorkspaceStorage, 'measure' | 'moveToTrash' | 'cleanUp' | 'restore' | 'emptyTrash'>;
    /** The workspace's folder on this machine; throws, in words, when it is not open here. */
    readonly root: (workspaceId: string) => string;
    readonly chatFiles: (workspaceId: string) => Promise<ChatFile[]>;
    /** The feature snapshot changed: push it. */
    readonly changed: () => void;
    /** One line in genie-host.log. */
    readonly log: (line: string) => void;
}

export type StorageFeaturePort = NonNullable<FeaturePorts['storage']> & {
    /** Resolves when the workspace's running Move or Empty, and the measure after it, are done (tests, shutdown). */
    idle(workspaceId: string): Promise<void>;
};

type Done = { outcome: string; failures: readonly StorageFailure[] };
interface Job { readonly action: StorageProgress['action']; readonly total: number }

const items = (n: number): string => `${n} ${n === 1 ? 'item' : 'items'}`;
const words = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const asFailures = (problems: readonly StorageProblem[]): StorageFailure[] => problems.map((p) => ({ label: p.label, reason: p.reason }));

export function storageFeaturePort(deps: StorageFeatureDeps): StorageFeaturePort {
    const views = new Map<string, StorageView>();
    const jobs = new Map<string, Job>();
    const settled = new Map<string, Promise<void>>();
    const set = (id: string, patch: Partial<StorageView>): void => {
        views.set(id, { measuring: false, report: null, error: null, outcome: null, ...views.get(id), ...patch });
        deps.changed();
    };
    const say = (id: string, line: string): void => deps.log(`storage: ${id}: ${line}`);

    const remeasure = async (id: string): Promise<void> => {
        set(id, { measuring: true });
        try {
            const report = await deps.storage.measure(deps.root(id), { chatFiles: await deps.chatFiles(id) });
            set(id, { measuring: false, report, error: null });
        } catch (error) {
            set(id, { measuring: false, error: `Genie could not measure this workspace: ${words(error)}` });
        }
    };

    /** Refused in words (and logged) while this workspace has a Move or Empty running. */
    const refuseWhileBusy = (id: string, what: string): void => {
        const job = jobs.get(id);
        if (!job) return;
        const p = views.get(id)?.progress;
        const far = p ? ` (${p.done} of ${p.total})` : '';
        const reason = job.action === 'move'
            ? `Genie is still moving items to .trash in this workspace${far}; wait for it to finish.`
            : `Genie is still emptying .trash in this workspace${far}; wait for it to finish.`;
        say(id, `${what} refused: ${reason}`);
        throw new Error(reason);
    };

    const rootOf = (id: string, what: string): string => {
        try { return deps.root(id); } catch (error) { say(id, `${what} refused: ${words(error)}`); throw error; }
    };

    /** Starts the work and answers; the work runs on, says how far it is, and ends with a result. */
    const start = (id: string, what: string, action: StorageProgress['action'], total: number, work: (root: string, onProgress: (e: StorageProgressEvent) => void) => Promise<Done>): void => {
        refuseWhileBusy(id, what);
        const root = rootOf(id, what);
        jobs.set(id, { action, total });
        set(id, { progress: { action, done: 0, total, bytes: 0, current: null }, outcome: null, failures: [] });
        const onProgress = (e: StorageProgressEvent): void => set(id, { progress: { action, ...e } });
        const run = async (): Promise<void> => {
            try {
                const done = await work(root, onProgress);
                for (const f of done.failures) say(id, `${action === 'move' ? 'not moved' : 'not deleted'}: ${f.label}: ${f.reason}`);
                say(id, done.outcome);
                set(id, { progress: null, outcome: done.outcome, failures: done.failures });
            } catch (error) {
                const outcome = `Genie could not finish ${action === 'move' ? 'moving items to .trash' : 'emptying .trash'}: ${words(error)}`;
                say(id, outcome);
                set(id, { progress: null, outcome, failures: [] });
            } finally {
                jobs.delete(id);
            }
            await remeasure(id);
        };
        settled.set(id, run());
    };

    return {
        views: () => Object.fromEntries(views),
        measure: (id) => { if (views.get(id)?.measuring !== true) void remeasure(id); },
        trash: async (id, itemId) => {
            start(id, 'Move to .trash', 'move', 1, async (root, onProgress) => {
                say(id, `moving ${itemId} to .trash`);
                const r = await deps.storage.moveToTrash(root, itemId, { chatFiles: await deps.chatFiles(id) });
                onProgress({ done: 1, total: 1, bytes: 0, current: r.ok ? r.label : itemId });
                return r.ok ? { outcome: `Moved ${r.label} to .trash.`, failures: [] } : { outcome: `Not moved to .trash: ${r.reason}`, failures: [{ label: itemId, reason: r.reason }] };
            });
        },
        cleanUp: async (id, itemIds) => {
            const total = new Set(itemIds).size;
            start(id, 'Clean up', 'move', total, async (root, onProgress) => {
                say(id, `moving ${items(total)} to .trash`);
                const r = await deps.storage.cleanUp(root, itemIds, { chatFiles: await deps.chatFiles(id) }, onProgress);
                const left = r.skipped.length + r.failed.length;
                const tail = left === 0 ? '.' : `; ${left} ${left === 1 ? 'was' : 'were'} not moved.`;
                return { outcome: `Moved ${r.moved.length} of ${items(total)} (${formatBytes(r.bytes)}) to .trash${tail}`, failures: asFailures(r.problems) };
            });
        },
        restore: async (id, trashId) => {
            refuseWhileBusy(id, 'Restore');
            const root = rootOf(id, 'Restore');
            say(id, `restoring ${trashId}`);
            const r = await deps.storage.restore(root, trashId);
            const outcome = r.ok ? `Put ${r.label} back.` : r.reason;
            say(id, r.ok ? outcome : `Restore of ${trashId} refused: ${r.reason}`);
            set(id, { outcome, failures: [] });
            const after = remeasure(id);
            settled.set(id, after);
        },
        empty: async (id, approval: TrashApproval) => {
            const total = Array.isArray(approval?.ids) ? approval.ids.length : 0;
            start(id, 'Empty trash', 'empty', total, async (root, onProgress) => {
                say(id, `emptying .trash: ${items(total)} (${formatBytes(typeof approval?.bytes === 'number' ? approval.bytes : 0)})`);
                const r = await deps.storage.emptyTrash(root, approval, onProgress);
                if (!r.ok) return { outcome: `Empty trash refused: ${r.reason}`, failures: [] };
                const tail = r.failed.length === 0 ? ' for good.' : ` for good; ${r.failed.length} could not be deleted.`;
                return { outcome: `Deleted ${r.deleted} of ${items(total)} (${formatBytes(r.bytes)}) from .trash${tail}`, failures: asFailures(r.failed) };
            });
        },
        idle: async (id) => { await settled.get(id); },
    };
}
