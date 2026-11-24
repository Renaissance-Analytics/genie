import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import type { TrustList } from '../core/workspace-trust.js';
import type { EnvelopeSites, WorkspaceRef } from './envelope-sites-host.js';
import { fileIsTracked, folderGitConfig, setGitReadPolicy, trustAwarePolicy } from './git-read-policy.js';
import { TRUST_PASS_MS, TrustWatch, watchOneFolder } from './trust-watch.js';
import { TrustReadInterrupted, WorkspaceTrust, type TrustView } from './workspace-trust-host.js';

/**
 * WHAT EACH WORKSPACE'S OWN FILES SAY WOULD RUN, AND WHETHER THE PERSON HAS SAID YES TO IT (genie#1519), AS THE HOSTING
 * HOLDS IT. THE HOST OWNS TRUST (the host split): the record and the verdicts live beside the hosting stack in genie-host,
 * which already reads `runtime/workspace-trust.json` for the sites, and sets its own git read policy from them. A window
 * reads no verdict of its own (2g-4d E2b, Tynn #955: the hosting replica is gone): the person's Trust and Untrust reach
 * genie-host over the protocol (features.act workspace.trust/untrust), and the trust steps come in features.snapshot.
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
    /** Told each time the person says yes to a workspace (Tynn #756, PR9b): what waited for the trust is restored. Absent on a view that only reads. */
    onTrusted?(listener: (workspaceId: string) => void): () => void;
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

/**
 * HOW LONG UNTIL A READ THAT FAILED IS TRIED AGAIN (Tynn #955), by how many in a row have failed: 1 s, 2 s, 4 s … and
 * never more than a minute. What could not be read is not trusted, and must not sit unread until a file happens to change.
 */
export function trustRetryDelayMs(failures: number): number {
    return Math.min(60_000, 1_000 * 2 ** Math.min(Math.max(failures, 1) - 1, 16));
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
    /** How long until a failed read is tried again, by how many in a row have failed. Absent = `trustRetryDelayMs`. */
    readonly retryMs?: ((failures: number) => number) | undefined;
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
        // `.flows/` and `.processes/` (Tynn #756, PR9b): what a clone would create, listed on the step before anything is.
        listDir: async (dir) => (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name),
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
    // A READ THAT FAILED IS TRIED AGAIN (Tynn #955): after a while, a longer while each time (`trustRetryDelayMs`), until
    // it is read or the workspace is gone or asleep. One wait for each workspace; a read that succeeds ends it.
    const retries = new Map<string, { failures: number; timer: ReturnType<typeof setTimeout> | null }>();
    const here = (id: string): boolean => input.workspaces().some((w) => w.id === id && !w.asleep);
    const wasRead = (id: string): void => {
        const retry = retries.get(id);
        if (!retry) return;
        if (retry.timer) clearTimeout(retry.timer);
        retries.delete(id);
    };
    const notRead = (id: string, error: unknown): void => {
        // An interrupted read is the interrupter's to finish (a redock reads it itself).
        if (closed || error instanceof TrustReadInterrupted) return;
        if (!here(id)) { wasRead(id); return; }
        const retry = retries.get(id) ?? { failures: 0, timer: null };
        retries.set(id, retry);
        if (retry.timer) return;
        retry.failures++;
        retry.timer = setTimeout(() => {
            retry.timer = null;
            if (closed || !here(id)) { retries.delete(id); return; }
            pass = pass.then(() => read(id).catch((again: unknown) => say(id, again)));
        }, (input.retryMs ?? trustRetryDelayMs)(retry.failures));
        retry.timer.unref?.();
    };
    /** Every read of a verdict here goes through this: the one guarded read (WorkspaceTrust.refresh), and its failure is tried again. */
    const read = (id: string, purpose?: 'redock'): Promise<TrustView | null> => workspaceTrust.refresh(id, purpose).then(
        (view) => { wasRead(id); return view; },
        (error: unknown) => { notRead(id, error); throw error; },
    );
    const refreshAll = () => {
        if (closed) return;
        pass = pass.then(() => Promise.all(input.workspaces().map((w) => read(w.id).catch((error: unknown) => say(w.id, error)))));
    };
    // A pull while an agent runs: nobody asks for the verdict, so what it reads is watched (trust-watch.ts).
    const watch = new TrustWatch({
        workspaces: input.workspaces,
        readText: input.readText,
        fingerprint: async (path) => {
            const info = await stat(path).catch(() => null);
            return info ? `${info.mtimeMs}:${info.size}` : null;
        },
        listDir: (dir) => readdir(dir),
        watchFolder: (folder, changed) => (input.watchFolders === false ? null : watchOneFolder(folder, changed)),
        refresh: (id) => {
            if (closed) return;
            pass = pass.then(() => read(id).catch((error: unknown) => say(id, error)));
        },
        settleMs: 500,
    });
    const watchPass = (): Promise<void> => watch.pass().catch((error: unknown) => say(null, error));
    // THE WATCH'S FIRST READINGS, THEN THE VERDICT (Tynn #955). The watch reads a verdict again only when a file's reading
    // differs from the one before. Were the verdict read first, a file arriving before the watch's first readings would
    // be in them already: no difference, ever, and "trusted, nothing would run" would stand over it. This way round, a
    // file that arrives between the two is either read by the verdict or differs at the next pass.
    const readingsThenVerdicts = () => { void watchPass().then(refreshAll); };
    readingsThenVerdicts();
    const timer = setInterval(() => { void watchPass(); }, input.everyMs ?? TRUST_PASS_MS);
    timer.unref();
    const entries = (): TrustEntry[] => input.workspaces().flatMap((w) => {
        const view = workspaceTrust.view(w.id);
        return view === null ? [] : [{ workspaceId: w.id, path: w.path, trusted: view.trusted, changed: view.changed, list: view.list }];
    });
    const api: TrustApi = {
        isTrustedPath: (path) => workspaceTrust.isTrustedPath(path),
        view: (id) => workspaceTrust.view(id),
        entries,
        refresh: (id, purpose) => read(id, purpose),
        // A Trust or an Untrust whose own read failed leaves the workspace unread: tried again, as any read is.
        trust: (id) => workspaceTrust.trust(id).catch((error: unknown) => { notRead(id, error); throw error; }),
        untrust: (id) => workspaceTrust.untrust(id).catch((error: unknown) => { notRead(id, error); throw error; }),
        onTrusted: (listener) => workspaceTrust.onTrusted(listener),
        mayWriteInto: async (folder) => {
            const workspace = input.workspaces().find((w) => w.path === folder);
            if (!workspace) return true;
            if (workspace.asleep) return false;
            return (await read(workspace.id))?.trusted === true;
        },
        onVerdict: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    return {
        api,
        suspendHidden: () => watch.suspendHidden(),
        workspacesChanged: () => { readingsThenVerdicts(); },
        close: async () => {
            setGitReadPolicy(null);
            closed = true;
            clearInterval(timer);
            for (const retry of retries.values()) if (retry.timer) clearTimeout(retry.timer);
            retries.clear();
            watch.stop();
            await pass;
        },
    };
}

/** The workspaces read and not trusted, with what would run: the person's trust step. */
export function trustSteps(entries: readonly TrustEntry[]): { readonly workspaceId: string; readonly changed: boolean; readonly list: TrustList }[] {
    return entries.filter((e) => !e.trusted).map((e) => ({ workspaceId: e.workspaceId, changed: e.changed, list: e.list }));
}
