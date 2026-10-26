import { join } from 'node:path';
import { tynnProjectIdOf } from '../core/issue-watch.js';
import type { SyncFlags, SyncFs } from './config-sync-targets.js';
import type { AgentRecord } from '../core/identity.js';
import { tynnAgentIdentities, type AgentCredentialPorts } from './tynn-agent-identities.js';

/** The scoped desktop account is a main-process API port; it never enters a provider's environment. */
export interface TynnSessionPort {
    status(): { readonly signedIn: boolean };
    userId?(): string | null;
    /**
     * The account id of the SAVED credential, before Tynn has confirmed it this launch (genie#1234): it lets an agent's
     * own stored key be used off grid. `null` once signed out or forgotten. Never a reason to mint or register.
     */
    savedUserId?(): string | null;
    request(path: string, init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown; signal?: AbortSignal }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}
export interface TynnMcp { readonly url: string; readonly token: string }
export type TynnAgentToken =
    | { readonly status: 'unlinked' }
    | { readonly status: 'already' | 'minted'; readonly mcp: TynnMcp; readonly remoteAgentId?: string;
        /** A stored key handed back without Tynn's word on it (signed out, or Tynn unreachable): checked once Tynn answers. */
        readonly unverified?: true }
    | { readonly status: 'failed'; readonly reason: string; readonly code?: 'offline' | 'inactive' | 'conflict' | 'pending' | 'storage' | 'refused' };
export const TYNN_SERVER_KEY = 'tynn';
export const TYNN_TOML_BEGIN = '# >>> tynn — managed by Genie; edits between the markers are replaced on sync';
export const TYNN_TOML_END = '# <<< tynn';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
export function secureMcpUrl(url: string): string {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return url; }
    if (parsed.protocol !== 'http:' || LOOPBACK_HOSTS.has(parsed.hostname)) return url;
    parsed.protocol = 'https:';
    return parsed.toString();
}

/** One private identity vault per Genie. Shared workspace credentials are never read, minted or returned. */
export function tynnAgentTokens(credentials?: AgentCredentialPorts) {
    const identities = credentials ? tynnAgentIdentities(credentials) : null;
    return {
        async ensure(input: {
            workspacePath: string; fs: SyncFs; agent: AgentRecord; tynn: TynnSessionPort | null; signal?: AbortSignal;
            // Accepted for older callers of the identity module; config switches never govern private credentials.
            flags?: SyncFlags; ignore?: () => Promise<void>;
        }): Promise<TynnAgentToken> {
            if (!input.agent) return { status: 'failed', code: 'refused', reason: 'A Genie agent identity is required. Shared workspace credentials are disabled.' };
            if (!identities) return { status: 'failed', code: 'storage', reason: 'Private Tynn agent credential storage is not configured.' };
            try {
                const projectId = tynnProjectIdOf(await input.fs.read(join(input.workspacePath, 'project.json').replace(/\\/g, '/')));
                return projectId ? identities.ensure({ projectId, agent: input.agent, tynn: input.tynn, ...(input.signal ? { signal: input.signal } : {}) }) : { status: 'unlinked' };
            } catch { return { status: 'failed', code: 'storage', reason: 'The workspace Tynn link could not be read.' }; }
        },
    };
}
