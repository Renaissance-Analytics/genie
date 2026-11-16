import { parseTabs, serializeTabs } from '../core/workspace-tabs.js';
import { tabsRestore, tabsRestorePlan } from '../core/workspace-tabs-save.js';
import { restoreFlows, type FlowPorts, type FlowRestore } from './workspace-flows-host.js';
import { restoreProcesses, type ProcessPorts, type ProcessRestore } from './workspace-processes-host.js';
import { restoreWorkspaceSettings, type RestorePorts, type SettingsRestore } from './workspace-restore-host.js';

/**
 * OPENING A FRESH CLONE, IN ORDER (Tynn #756, PR9a; the owner, 2026-11-16: a fresh clone restores flows disarmed and processes
 * stopped; the person starts them, after the workspace's trust).
 *
 * 1. The workspace's SETTINGS (project.json's `workspace`): declarative, needs no trust, applied only where the clone has chosen nothing.
 * 2. Its TABS (`.genie/tabs.json`): a tab the clone lacks is added; nothing it has is overwritten.
 * 3. The TRUST verdict, once: the person's one-time yes (core/workspace-trust.ts).
 * 4. Its FLOWS (`.flows/`), always DISARMED; one that runs a command waits for the trust.
 * 5. Its PROCESSES (`.processes/`), kept STOPPED (a scheduled task paused); each waits for the trust.
 *
 * Nothing that would run anything is created before the trust, nothing the clone already has is overwritten, and one step failing
 * never stops the next: it is said in `skipped`. The restore runs in the host that owns the stores (genie-host).
 */

export interface CloneRestorePorts {
    /** Absolute paths: the file's text (null when it is not there) and the names in a folder (rejects when it is not there). */
    readonly files: { read(path: string): Promise<string | null>; list(dir: string): Promise<string[]> };
    readonly settings: RestorePorts;
    readonly tabs: {
        /** The three settings the tabs live in, as they are kept (`''` for one never set). */
        values(workspaceId: string): { tabs: string; panelSplits: string; panelLayout: string };
        /** The workspace's own setting overrides: what the person here already chose. */
        overridden(workspaceId: string): Readonly<Record<string, unknown>>;
        write(workspaceId: string, key: 'workspace_tabs' | 'panel_splits' | 'panel_layout', value: string): Promise<unknown>;
        /** The `<name>.gen` hosts of this workspace's sites: a site panel names one of them. */
        siteHosts(workspaceId: string): readonly string[];
    };
    /** The flow store, or null while the host has not opened it yet (it opens at its own pace). */
    flows: () => Promise<FlowPorts | null>;
    /** The process book, or null while the host has not opened it yet. */
    processes: () => Promise<ProcessPorts | null>;
    /** The person's one-time yes to this workspace. */
    trusted(workspaceId: string): boolean;
}

export interface TabsRestoreReport {
    readonly added: string[];
    readonly present: string[];
    readonly differs: string[];
    /** The settings written: `workspace_tabs`, `panel_splits`, `panel_layout`. */
    readonly wrote: string[];
    readonly notes: string[];
}

export interface CloneRestore {
    /** The steps that ran, in the order they ran. */
    readonly order: string[];
    readonly settings: SettingsRestore | null;
    readonly tabs: TabsRestoreReport | null;
    readonly trusted: boolean;
    readonly flows: FlowRestore | null;
    readonly processes: ProcessRestore | null;
    /** What did not run, and why: a project.json that is not there, a store not open yet, a step that failed. */
    readonly skipped: { step: string; reason: string }[];
}

const EMPTY = { created: [], present: [], differs: [], waiting: [], refused: [], ignored: [] };
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function restoreClone(workspace: { id: string; path: string }, ports: CloneRestorePorts): Promise<CloneRestore> {
    const order: string[] = [];
    const skipped: { step: string; reason: string }[] = [];
    let settings: SettingsRestore | null = null;
    let tabs: TabsRestoreReport | null = null;
    let trusted = false;
    let flows: FlowRestore | null = null;
    let processes: ProcessRestore | null = null;
    const done = (): CloneRestore => ({ order, settings, tabs, trusted, flows, processes, skipped });
    const at = (rel: string): string => `${workspace.path.replace(/[\\/]+$/, '')}/${rel}`;

    const manifestText = await ports.files.read(at('project.json'));
    if (manifestText === null) { skipped.push({ step: 'project.json', reason: 'this workspace has no project.json' }); return done(); }
    let manifest: unknown;
    try { manifest = JSON.parse(manifestText); } catch (error) { skipped.push({ step: 'project.json', reason: `project.json is not valid JSON (${reasonOf(error)})` }); return done(); }

    /** The `.json` files in a folder of the workspace, by name; a folder that is not there has none. */
    const filesIn = async (dir: string): Promise<{ path: string; text: string }[]> => {
        let names: string[];
        try { names = await ports.files.list(at(dir)); } catch { return []; }
        const out: { path: string; text: string }[] = [];
        for (const name of names.filter((n) => n.toLowerCase().endsWith('.json')).sort()) {
            const text = await ports.files.read(at(`${dir}/${name}`));
            if (text !== null) out.push({ path: `${dir}/${name}`, text });
        }
        return out;
    };

    order.push('settings');
    try { settings = await restoreWorkspaceSettings(manifest, workspace.id, ports.settings); } catch (error) { skipped.push({ step: 'settings', reason: reasonOf(error) }); }

    const tabsText = await ports.files.read(at('.genie/tabs.json'));
    if (tabsText !== null) {
        order.push('tabs');
        try {
            let file: unknown;
            try { file = JSON.parse(tabsText); } catch (error) { throw new Error(`.genie/tabs.json is not valid JSON (${reasonOf(error)})`); }
            const restored = tabsRestore(file, { workspacePath: workspace.path, siteHosts: ports.tabs.siteHosts(workspace.id) });
            const have = ports.tabs.values(workspace.id);
            const plan = tabsRestorePlan(restored.state, parseTabs(have.tabs));
            const chosen = ports.tabs.overridden(workspace.id);
            const wrote: string[] = [];
            if (plan.add.length > 0) { await ports.tabs.write(workspace.id, 'workspace_tabs', serializeTabs(plan.state)); wrote.push('workspace_tabs'); }
            if (restored.panelSplits !== null && !('panel_splits' in chosen)) { await ports.tabs.write(workspace.id, 'panel_splits', restored.panelSplits); wrote.push('panel_splits'); }
            if (restored.panelLayout !== null && !('panel_layout' in chosen)) { await ports.tabs.write(workspace.id, 'panel_layout', restored.panelLayout); wrote.push('panel_layout'); }
            tabs = { added: plan.add.map((t) => t.id), present: plan.present, differs: plan.differs, wrote, notes: restored.notes };
        } catch (error) {
            skipped.push({ step: 'tabs', reason: reasonOf(error) });
        }
    }

    order.push('trust');
    trusted = ports.trusted(workspace.id);

    order.push('flows');
    try {
        const files = await filesIn('.flows');
        if (files.length === 0) flows = { ...EMPTY, created: [], present: [], differs: [], waiting: [], refused: [], ignored: [] };
        else {
            const store = await ports.flows();
            if (store === null) skipped.push({ step: 'flows', reason: 'the flow store is not open yet' });
            else flows = await restoreFlows(files, workspace.id, store, { trusted });
        }
    } catch (error) {
        skipped.push({ step: 'flows', reason: reasonOf(error) });
    }

    order.push('processes');
    try {
        const files = await filesIn('.processes');
        if (files.length === 0) processes = { ...EMPTY, created: [], present: [], differs: [], waiting: [], refused: [], ignored: [] };
        else {
            const book = await ports.processes();
            if (book === null) skipped.push({ step: 'processes', reason: 'the process book is not open yet' });
            else processes = await restoreProcesses(files, { workspaceId: workspace.id, workspacePath: workspace.path, ports: book, trusted });
        }
    } catch (error) {
        skipped.push({ step: 'processes', reason: reasonOf(error) });
    }
    return done();
}

/**
 * Tells `onNew` of each workspace that APPEARS after watching began (a clone just added), once, and never one that is hibernated:
 * a ghost is not restored into. A workspace that was already there is not a clone being opened.
 */
export function watchNewWorkspaces(registry: { workspaceStates(): readonly { id: string; asleep?: boolean }[]; subscribe(listener: () => void): () => void }, onNew: (workspaceId: string) => void): () => void {
    const known = new Set(registry.workspaceStates().map((w) => w.id));
    return registry.subscribe(() => {
        for (const w of registry.workspaceStates()) {
            if (known.has(w.id)) continue;
            known.add(w.id);
            if (w.asleep !== true) onNew(w.id);
        }
    });
}
