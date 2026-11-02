import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRecord } from '../core/identity.js';
import { tynnProjectIdOf } from '../core/issue-watch.js';
import type { McpServer } from '@particle-academy/prism-acp';
import { tynnAgentIdentities, type AgentSecrets } from './tynn-agent-identities.js';
import { tynnUnavailableNote, type TynnSessionPort } from './tynn-agent-token.js';

/**
 * AN AGENT'S TYNN KEY, WITH NO WINDOW (the owner's decision 3, genie#1457). What the host starts itself, a mail wake or a
 * flow, has its key: the binding is in the vault, the key is in the host's keychain, and the off-grid path (genie#1234) reads
 * them with no call to Tynn. The account is the one on disk: `credentials/tynn.json` says who is signed in in the clear, and
 * only its pairing token is sealed.
 *
 * It hands out what the window minted, and nothing else. A never-minted agent with no window starts without Tynn, with the
 * note saying so, until cut c gives the host the account (and verification at start with it).
 */
export interface HostAgentKeysOptions {
    readonly vaultFile: string;
    readonly accountFile?: string;
    readonly tynnHost?: string;
    readonly keychain: AgentSecrets;
    readonly tynn?: () => TynnSessionPort | null;
    readonly workspaces?: () => readonly { readonly id: string; readonly path: string; readonly asleep?: boolean }[];
}
export interface HostAgentKeysResult {
    readonly servers: readonly McpServer[];
    readonly note: string | null;
}
export type HostAgentKeys = ((agent: AgentRecord, cwd: string) => Promise<HostAgentKeysResult>) & { recovery(options?: { secretsMoved?: boolean }): Promise<string[]> };

const textOf = (file: string): Promise<string | null> => readFile(file, 'utf8').catch(() => null);

async function savedAccount(file: string, tynnHost: string): Promise<string | null> {
    const text = await textOf(file);
    if (text === null) return null;
    try {
        const data = JSON.parse(text) as { version?: unknown; state?: unknown; host?: unknown; userId?: unknown };
        return data.version === 1 && data.state === 'signed-in' && data.host === tynnHost && typeof data.userId === 'string' ? data.userId : null;
    } catch {
        return null;
    }
}

export function hostAgentKeys(options: HostAgentKeysOptions): HostAgentKeys {
    const read = async (agent: AgentRecord, cwd: string): Promise<HostAgentKeysResult> => {
        const projectId = tynnProjectIdOf(await textOf(join(cwd, 'project.json')));
        if (projectId === null) return { servers: [], note: null };
        const userId = await savedAccount(options.accountFile ?? '', options.tynnHost ?? '');
        const noNetwork: TynnSessionPort = {
            status: () => ({ signedIn: false }),
            savedUserId: () => userId,
            request: () => Promise.reject(new Error('The host has no account to call Tynn with.')),
        };
        // A new reader each time: the window writes this vault, and what it minted a moment ago must be found.
        const result = await tynnAgentIdentities({ file: options.vaultFile, secrets: options.keychain }).ensure({ projectId, agent, tynn: noNetwork });
        if (result.status === 'failed') return { servers: [], note: tynnUnavailableNote(result.code ?? 'refused') };
        if (result.status === 'unlinked') return { servers: [], note: null };
        return { servers: [{ type: 'http', name: 'tynn', url: result.mcp.url, headers: [{ name: 'Authorization', value: `Bearer ${result.mcp.token}` }] }], note: null };
    };
    return Object.assign(read, { recovery: async () => [] as string[] });
}
