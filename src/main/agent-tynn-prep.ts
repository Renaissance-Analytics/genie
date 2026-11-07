import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpServer } from '@particle-academy/prism-acp';
import type { AgentRecord } from '../core/identity.js';
import { tynnProjectIdOf } from '../core/issue-watch.js';
import { OS_WORKSPACE } from '../core/os-agent.js';
import { McpPreparationError } from './mcp-preparation-error.js';
import type { AgentSecrets } from './tynn-agent-identities.js';
import { tynnAgentTokens, tynnUnavailableNote, type TynnFailure, type TynnSessionPort } from './tynn-agent-token.js';
import { nodeTynnConfigFs, reconcileLegacyTynnConfig } from './tynn-config-cleanup.js';

/**
 * PREPARING AN AGENT'S TYNN SERVER: its own key, minted the first time, asked after at each start, held in the keychain. genie-host does
 * this (host-agent-keys.ts), with or without a window; a window running its own engine, because the host could not start, does it through
 * compose. One piece of code either way, and never both for one vault.
 *
 * OFF GRID (genie#1234, the owner 2026-10-26: "Genie must work off grid"). An agent whose credential could not be prepared starts WITHOUT the
 * `tynn` server and is told why, and a sign-in brings the server back. It never starts on a shared workspace credential.
 */
export interface AgentTynnPrepOptions {
    readonly vaultFile: string;
    readonly secrets: AgentSecrets;
    readonly tynn: () => (TynnSessionPort & { unreachableThrough?(): string | null }) | null | undefined;
    readonly workspaces: () => readonly { readonly id: string; readonly path: string; readonly asleep?: boolean | undefined }[] | undefined;
    /** Cleanup and normal config sync share one writer in a process. Absent = none here to share with. */
    readonly withConfig?: <T>(path: string, run: () => Promise<T>) => Promise<T>;
    /** What must finish before a key is read: the account opening, or a window's one-time move. */
    readonly ready?: () => Promise<unknown>;
    /**
     * A workspace this does not know, or knows as asleep, may be one a write in flight is about to change: a window's add goes over the same
     * socket as its start, and the host runs its calls concurrently. Waits for those writes, so an ordinary click is never refused.
     */
    readonly settled?: () => Promise<void>;
}

const projectText = async (workspacePath: string): Promise<string | null> => {
    try {
        const file = join(workspacePath, 'project.json');
        const stat = await lstat(file);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error();
        const text = await readFile(file, 'utf8');
        const data: unknown = JSON.parse(text);
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
        return text;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new McpPreparationError('workspace');
    }
};

export function agentTynnPrep(options: AgentTynnPrepOptions) {
    const tokens = tynnAgentTokens({ file: options.vaultFile, secrets: options.secrets });
    const withConfig = options.withConfig ?? (<T>(_path: string, run: () => Promise<T>) => run());
    const without = new Map<string, TynnFailure>();
    /** What each of them needs to ask again. */
    const prepared = new Map<string, { agent: AgentRecord; path: string; text: string | null }>();
    const unverified = new Map<string, { agent: AgentRecord; path: string; text: string | null }>();
    const restart = new Set<string>();

    const note = (agentId: string): string | null => {
        const code = without.get(agentId);
        return code ? tynnUnavailableNote(code, code === 'offline' ? options.tynn()?.unreachableThrough?.() ?? null : null) : null;
    };

    /** Signed out or unreachable: the failures a sign-in can cure. The rest need the person, and are not restarted in a loop. */
    const SIGN_IN_CURES: ReadonlySet<TynnFailure> = new Set<TynnFailure>(['refused', 'offline']);

    const ask = (held: { agent: AgentRecord; path: string; text: string | null }, tynn: TynnSessionPort | null) => tokens.ensure({
        workspacePath: held.path, agent: held.agent, tynn,
        fs: { read: async () => held.text, write: async () => { throw new Error('Private agent credentials never enter a workspace'); } },
    });

    /**
     * WHO SHOULD RESTART. Only an agent the host now holds a key for: a restart is not a way of finding out. The key is asked for HERE, so a Tynn
     * that answers /me and fails its agent endpoints restarts nobody, and the agent keeps running as it is until this can really help it. What
     * Tynn refuses outright stops being a wait. `secretsMoved`: an older Genie's keys have just reached the keychain, which may cure what could not
     * be found there.
     */
    const recovery = async (asked: { readonly secretsMoved?: boolean } = {}): Promise<string[]> => {
        const tynn = options.tynn() ?? null;
        const signedIn = tynn?.status().signedIn === true;
        const named = new Set<string>(signedIn ? restart : []);
        for (const [id, code] of [...without]) {
            if (!(signedIn && SIGN_IN_CURES.has(code)) && !(asked.secretsMoved && code === 'storage')) continue;
            const held = prepared.get(id);
            if (!held) continue;
            const result = await ask(held, tynn);
            if (result.status === 'failed') without.set(id, result.code ?? 'refused');
            else if (result.status !== 'unlinked' && !result.unverified) named.add(id);
        }
        if (!signedIn) return [...named];
        // The keys handed out unverified are checked now; one Tynn refuses is taken away by a restart without it.
        for (const [id, held] of [...unverified]) {
            const result = await ask(held, tynn);
            if (result.status === 'failed') {
                if (result.code === 'offline') continue;
                unverified.delete(id); restart.add(id); named.add(id);
            } else if (result.status === 'unlinked' || !result.unverified) unverified.delete(id);
        }
        return [...named];
    };

    const prepare = async (agent: AgentRecord, signal: AbortSignal): Promise<readonly McpServer[]> => {
        const checkStop = () => { if (signal.aborted) throw new McpPreparationError('cancelled'); };
        checkStop();
        if (agent.workspaceId === OS_WORKSPACE) return [];
        const known = () => options.workspaces()?.find((w) => w.id === agent.workspaceId);
        let workspace = known();
        if (!workspace || workspace.asleep) { await options.settled?.(); workspace = known(); checkStop(); }
        if (!workspace || workspace.asleep) throw new McpPreparationError('workspace');
        const here = workspace;
        const text = await projectText(here.path);
        await withConfig(here.path, () => reconcileLegacyTynnConfig({ workspacePath: here.path, fs: nodeTynnConfigFs(here.path) }));
        checkStop();
        const projectId = tynnProjectIdOf(text);
        if (projectId === null) return [];
        await options.ready?.();
        const ensure = (tynn: TynnSessionPort | null) => tokens.ensure({
            workspacePath: here.path, agent, signal, tynn,
            fs: { read: async () => text, write: async () => { throw new Error('Private agent credentials never enter a workspace'); } },
        });
        const asked = options.tynn() ?? null;
        const signedInThen = asked?.status().signedIn === true;
        let result = await ensure(asked);
        checkStop();
        // The account signed in WHILE this agent prepared (at launch it opens after the first agents start): its change
        // event has already gone by, so nothing would recover this agent later. Asked once more, now.
        const now = options.tynn() ?? null;
        if (result.status === 'failed' && result.code === 'refused' && now?.status().signedIn && (now !== asked || !signedInThen)) {
            result = await ensure(now);
            checkStop();
        }
        restart.delete(agent.id); unverified.delete(agent.id);
        // No credential: the agent starts WITHOUT the tynn server (genie#1234), never on a shared workspace credential.
        if (result.status === 'failed') { without.set(agent.id, result.code ?? 'refused'); prepared.set(agent.id, { agent, path: here.path, text }); return []; }
        if (result.status === 'unlinked') throw new McpPreparationError('workspace');
        const current = options.workspaces()?.find((w) => w.id === agent.workspaceId);
        if (!current || current.asleep || current.path !== here.path || tynnProjectIdOf(await projectText(here.path)) !== projectId) throw new McpPreparationError('workspace');
        checkStop();
        without.delete(agent.id);
        prepared.delete(agent.id);
        if (result.unverified) unverified.set(agent.id, { agent, path: here.path, text });
        return [{ type: 'http', name: 'tynn', url: result.mcp.url, headers: [{ name: 'Authorization', value: `Bearer ${result.mcp.token}` }] }];
    };

    /** Is an agent running without what Tynn answering would give it: no key for want of Tynn, or a key nobody has checked? */
    const waiting = (): boolean => unverified.size > 0 || [...without.values()].includes('offline');

    return { prepare, note, recovery, waiting, legacyKeys: tokens.legacyKeys };
}
