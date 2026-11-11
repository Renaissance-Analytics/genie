import { stat } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import type { TrustList } from '../core/workspace-trust.js';
import type { EnvelopeSites, WorkspaceRef } from './envelope-sites-host.js';
import { fileIsTracked, folderGitConfig, setGitReadPolicy, trustAwarePolicy } from './git-read-policy.js';
import { TRUST_PASS_MS, TrustWatch, watchOneFolder } from './trust-watch.js';
import { WorkspaceTrust, type TrustView } from './workspace-trust-host.js';

/**
 * WHAT EACH WORKSPACE'S OWN FILES SAY WOULD RUN, AND WHETHER THE PERSON HAS SAID YES TO IT (genie#1519), AS THE HOSTING
 * HOLDS IT. THE HOST OWNS TRUST (the host split): the record and the verdicts live beside the hosting stack in genie-host,
 * which already reads `runtime/workspace-trust.json` for the sites. A local window reads a replica of the verdicts from
 * the hosting dump (hosting-host.ts `HostingReplica`), and FAILS CLOSED: before its first dump, and after its link drops,
 * every workspace reads as untrusted there. The no-host emergency path composes this same stack in the window until P6.
 */

/** One workspace's verdict as the host last read it: what a window's synchronous checks read. */
export interface TrustEntry {
    readonly workspaceId: string;
    readonly path: string;
    readonly trusted: boolean;
    readonly changed: boolean;
    readonly list: TrustList;
}

export interface TrustApi {
    /** As last read. A folder in no workspace read yet, or in one not trusted, is not trusted. */
    isTrustedPath(path: string): boolean;
    /** As last read, without reading. `null` = not read yet. */
    view(workspaceId: string): TrustView | null;
    /** Every workspace read, with its verdict. */
    entries(): TrustEntry[];
    /** Read the workspace's files again and answer. */
    refresh(workspaceId: string, purpose?: 'redock'): Promise<TrustView | null>;
    /** The person's yes to what the workspace says now. Recorded first: a save that fails leaves it untrusted. */
    trust(workspaceId: string): Promise<TrustView | null>;
    /** The person takes the yes back: the only thing that ends a workspace's trust (Tynn #618). */
    untrust(workspaceId: string): Promise<TrustView | null>;
    /** A registered workspace's folder takes Genie's files only once trusted. A folder that is no workspace is not this rule's. */
    mayWriteInto(folder: string): Promise<boolean>;
    /** A verdict moved. Fired after the record and the views are updated, so a reader then reads the new verdict. */
    onVerdict(listener: (workspaceId: string) => void): () => void;
}

/** Whether `path` is `root` or inside it. */
export function insideFolder(root: string, path: string): boolean {
    const rel = relative(root, path);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The verdict `entries` give `path`: the first workspace holding it, and no workspace is no trust. */
export function trustedPathIn(entries: readonly TrustEntry[], path: string): boolean {
    for (const entry of entries) if (insideFolder(entry.path, path)) return entry.trusted;
    return false;
}

export interface OwnTrustInput {
    readonly workspaces: () => readonly WorkspaceRef[];
    readonly envelopeSites: Pick<EnvelopeSites, 'trustRecord' | 'recordWorkspace' | 'approveSites' | 'forgetWorkspaceTrust'>;
    readonly readText: (path: string) => Promise<string | null>;
    /** The slow pass over what a verdict reads. Absent = `TRUST_PASS_MS`. */
    readonly everyMs?: number | undefined;
    /** False = no folder watchers, the slow pass alone. Absent = watch. */
    readonly watchFolders?: boolean | undefined;
    /** Also told when a verdict moved (after the record). */
    readonly verdictMoved?: ((workspaceId: string) => void) | undefined;
}

export interface OwnTrust {
    readonly api: TrustApi;
    /** Metadata-only teardown before a workspace sync; it starts no refresh or new folder read. */
    suspendHidden(): void;
    /** Every workspace read again (after a workspace change), and the watchers follow. */
    workspacesChanged(): void;
    /** No pass starts from here; the one in flight is waited for, and this process's git policy goes with it. */
    close(): Promise<void>;
}

/**
 * The trust of the process that composes the hosting: genie-host's, or the window's own on the emergency path. Sets this
 * process's git read policy (git-read-policy.ts) from its own verdicts.
 */
export function ownTrust(input: OwnTrustInput): OwnTrust {
    const listeners = new Set<(workspaceId: string) => void>();
    const workspaceTrust = new WorkspaceTrust({
        readText: input.readText,
        gitConfig: folderGitConfig,
        isTracked: fileIsTracked,
        workspaces: input.workspaces,
        record: () => input.envelopeSites.trustRecord(),
        recordWorkspace: (id, hash) => input.envelopeSites.recordWorkspace(id, hash),
        forgetWorkspace: (id) => input.envelopeSites.forgetWorkspaceTrust(id),
        approveSites: (id) => input.envelopeSites.approveSites(id),
        // Fired from inside WorkspaceTrust once its view is kept: the record first, then whoever is told.
        verdictMoved: (id) => {
            input.verdictMoved?.(id);
            for (const l of [...listeners]) { try { l(id); } catch { /* one listener never costs another */ } }
        },
    });
    setGitReadPolicy(trustAwarePolicy((path) => workspaceTrust.isTrustedPath(path)));
    // One pass at a time, and a quit waits for the one in flight: it reads through git in the workspace's folder and writes the record.
    let pass: Promise<unknown> = Promise.resolve();
    let closed = false;
    const say = (id: string | null, error: unknown) => console.error(`[trust] ${id === null ? '' : `${id} could not be read: `}${error instanceof Error ? error.message : String(error)}`);
    const refreshAll = () => {
        if (closed) return;
        pass = pass.then(() => Promise.all(input.workspaces().map((w) => workspaceTrust.refresh(w.id).catch((error: unknown) => say(w.id, error)))));
    };
    refreshAll();
    // A pull while an agent runs: nobody asks for the verdict, so what it reads is watched (trust-watch.ts).
    const watch = new TrustWatch({
        workspaces: input.workspaces,
        readText: input.readText,
        fingerprint: async (path) => {
            const info = await stat(path).catch(() => null);
            return info ? `${info.mtimeMs}:${info.size}` : null;
        },
        watchFolder: (folder, changed) => (input.watchFolders === false ? null : watchOneFolder(folder, changed)),
        refresh: (id) => {
            if (closed) return;
            pass = pass.then(() => workspaceTrust.refresh(id).catch((error: unknown) => say(id, error)));
        },
        settleMs: 500,
    });
    const watchPass = () => { watch.pass().catch((error: unknown) => say(null, error)); };
    watchPass();
    const timer = setInterval(watchPass, input.everyMs ?? TRUST_PASS_MS);
    timer.unref();
    const entries = (): TrustEntry[] => input.workspaces().flatMap((w) => {
        const view = workspaceTrust.view(w.id);
        return view === null ? [] : [{ workspaceId: w.id, path: w.path, trusted: view.trusted, changed: view.changed, list: view.list }];
    });
    const api: TrustApi = {
        isTrustedPath: (path) => workspaceTrust.isTrustedPath(path),
        view: (id) => workspaceTrust.view(id),
        entries,
        refresh: (id, purpose) => workspaceTrust.refresh(id, purpose),
        trust: (id) => workspaceTrust.trust(id),
        untrust: (id) => workspaceTrust.untrust(id),
        mayWriteInto: async (folder) => {
            const workspace = input.workspaces().find((w) => w.path === folder);
            if (!workspace) return true;
            if (workspace.asleep) return false;
            return (await workspaceTrust.refresh(workspace.id))?.trusted === true;
        },
        onVerdict: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    return {
        api,
        suspendHidden: () => watch.suspendHidden(),
        workspacesChanged: () => { refreshAll(); watchPass(); },
        close: async () => {
            setGitReadPolicy(null);
            closed = true;
            clearInterval(timer);
            watch.stop();
            await pass;
        },
    };
}

/** The workspaces read and not trusted, with what would run: the person's trust step. */
export function trustSteps(entries: readonly TrustEntry[]): { readonly workspaceId: string; readonly changed: boolean; readonly list: TrustList }[] {
    return entries.filter((e) => !e.trusted).map((e) => ({ workspaceId: e.workspaceId, changed: e.changed, list: e.list }));
}
