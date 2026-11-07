import type { McpServer } from '@particle-academy/prism-acp';
import type { AgentRecord } from '../core/identity.js';
import { agentTynnPrep, type AgentTynnPrepOptions } from './agent-tynn-prep.js';
import type { AgentSecrets } from './tynn-agent-identities.js';

/**
 * AN AGENT'S TYNN KEY IS THE HOST'S (the owner's decision 3, genie#1457: "this should not happen at all. fix it, don't bandaid it"). The host
 * holds the account and the keychain, so it mints a key the first time, asks after it at each start, and hands it to the provider,
 * with a window open or not. What it could not hand out, it says why, in the agent's chat.
 */
export interface HostAgentKeysOptions {
    readonly vaultFile: string;
    readonly keychain: AgentSecrets;
    readonly tynn: AgentTynnPrepOptions['tynn'];
    readonly workspaces: AgentTynnPrepOptions['workspaces'];
    readonly ready?: AgentTynnPrepOptions['ready'];
    readonly settled?: () => Promise<void>;
    /** The lock a workspace's config is written under (workspace-config-sync.ts). */
    readonly withConfig?: <T>(path: string, run: () => Promise<T>) => Promise<T>;
    /** An agent was prepared: whoever keeps asking for Tynn looks again. */
    readonly onPrepared?: () => void;
}
export interface HostAgentKeysResult {
    readonly servers: readonly McpServer[];
    readonly note: string | null;
}
export type HostAgentKeys = ((agent: AgentRecord, cwd: string, signal?: AbortSignal) => Promise<HostAgentKeysResult>) & {
    recovery(options?: { readonly secretsMoved?: boolean }): Promise<string[]>;
    waiting(): boolean;
};

export function hostAgentKeys(options: HostAgentKeysOptions): HostAgentKeys {
    const prep = agentTynnPrep({
        vaultFile: options.vaultFile,
        secrets: options.keychain,
        tynn: options.tynn,
        workspaces: options.workspaces,
        ...(options.withConfig ? { withConfig: options.withConfig } : {}),
        ...(options.ready ? { ready: options.ready } : {}),
        ...(options.settled ? { settled: options.settled } : {}),
    });
    const read = async (agent: AgentRecord, _cwd: string, signal: AbortSignal = new AbortController().signal): Promise<HostAgentKeysResult> => {
        const servers = await prep.prepare(agent, signal);
        options.onPrepared?.();
        return { servers, note: prep.note(agent.id) };
    };
    return Object.assign(read, { recovery: prep.recovery, waiting: prep.waiting });
}
