import { readFile } from 'node:fs/promises';
import { isAcpProvider } from '../core/engine.js';
import type { AgentRecord } from '../core/identity.js';
import { TYNN_HOST } from '../core/tynn.js';
import type { TynnAgentToken, TynnSessionPort } from './tynn-agent-token.js';
import { preparePrivateCredential, writePrivateCredential } from './private-credentials.js';

export interface AgentCredentialPorts {
    readonly file: string;
    readonly cipher: { isAvailable(): boolean; encrypt(text: string): Buffer; decrypt(bytes: Buffer): string };
}
type FailureCode = 'offline' | 'inactive' | 'conflict' | 'pending' | 'storage' | 'refused';
class ProvisionFailure extends Error {
    constructor(readonly code: FailureCode, message: string) { super(message); }
}
interface Stored {
    readonly userId: string;
    readonly projectId: string;
    readonly genieId: string;
    readonly remoteAgentId: string;
    readonly state: 'pending' | 'ready';
    readonly publicId?: string;
    readonly tokenEnc?: string;
}
interface RemoteAgent {
    readonly id: string;
    readonly name: string;
    readonly external_id: string | null;
    readonly status: 'active' | 'suspended' | 'archived';
    readonly tokens: readonly { readonly public_id: string; readonly active: boolean; readonly scope_target?: string }[];
}
const MCP_URL = `${TYNN_HOST}/mcp/tynn`;
const RPK = /^rpk_([0-9A-HJKMNP-TV-Z]{26})\.[a-f0-9]{64}$/i;
const object = (value: unknown): Record<string, unknown> | null => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
function remoteAgent(value: unknown): RemoteAgent | null {
    const row = object(value);
    if (!row || typeof row.id !== 'string' || !row.id || typeof row.name !== 'string' || !row.name.trim()
        || (row.external_id !== null && typeof row.external_id !== 'string') || !['active', 'suspended', 'archived'].includes(String(row.status)) || !Array.isArray(row.tokens)) return null;
    if (row.tokens.some((token) => { const t = object(token); return !t || typeof t.public_id !== 'string' || typeof t.active !== 'boolean'; })) return null;
    return row as unknown as RemoteAgent;
}

/** Main-process vault and identity provisioner. No project file supplies or receives an agent credential. */
export function tynnAgentIdentities(ports: AgentCredentialPorts) {
    let rows: Promise<Record<string, Stored>> | null = null;
    let writes: Promise<unknown> = Promise.resolve();
    const inFlight = new Map<string, Promise<TynnAgentToken>>();
    const projects = new Map<string, Promise<TynnAgentToken>>();

    const load = (): Promise<Record<string, Stored>> => rows ??= (async () => {
        let text: string;
        try { await preparePrivateCredential(ports.file); text = await readFile(ports.file, 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new ProvisionFailure('storage', 'The private Tynn agent vault could not be read.'); }
        try {
            const parsed = object(JSON.parse(text));
            const records = object(parsed?.records);
            if (parsed?.version !== 1 || !records) throw new Error();
            return records as unknown as Record<string, Stored>;
        } catch { throw new ProvisionFailure('storage', 'The private Tynn agent vault is invalid; no new key was requested.'); }
    })();

    const save = (key: string, record: Stored): Promise<void> => {
        const run = async () => {
            const next = { ...await load(), [key]: record };
            try {
                await writePrivateCredential(ports.file, JSON.stringify({ version: 1, records: next }));
                rows = Promise.resolve(next);
            } catch { throw new ProvisionFailure('storage', 'The private Tynn agent vault could not be saved. Review any pending key before trying again.'); }
        };
        const work = writes.then(run, run); writes = work.catch(() => {}); return work;
    };

    async function decide(input: { projectId: string; agent: AgentRecord; tynn: TynnSessionPort | null }, userId: string, key: string): Promise<TynnAgentToken> {
        const { projectId, agent, tynn } = input;
        if (!ports.cipher.isAvailable()) throw new ProvisionFailure('storage', 'Unlock OS credential encryption before provisioning a Tynn agent.');
        const currentAccount = () => {
            if (!tynn?.status().signedIn || tynn.userId?.() !== userId) throw new ProvisionFailure('refused', 'The Tynn account changed. Check the account before provisioning this agent.');
        };
        currentAccount();
        const permissions = agent.permissions ?? 'all';
        if (!isAcpProvider(agent.provider) || !agent.name.trim() || agent.name !== agent.name.trim() || agent.name.length > 255 || /[\x00-\x1f]/.test(agent.name)
            || !['all', 'ask', 'edits'].includes(permissions) || !['automated', 'manual'].includes(agent.mode)
            || (agent.instructions !== null && (agent.instructions.length > 20_000 || /^[\\/]|^[A-Za-z]:|\x00/.test(agent.instructions) || agent.instructions.replace(/\\/g, '/').split('/').includes('..')))) {
            throw new ProvisionFailure('conflict', 'The local agent has invalid Tynn configuration.');
        }
        const records = await load();
        const known = records[key];
        if (Object.hasOwn(records, key) && (!known || !object(known) || known.userId !== userId || known.projectId !== projectId || known.genieId !== agent.id || typeof known.remoteAgentId !== 'string' || !['pending', 'ready'].includes(known.state))) {
            throw new ProvisionFailure('storage', 'The stored Tynn agent binding is invalid.');
        }
        const api = async (path: string, method: 'GET' | 'POST', body?: unknown): Promise<Record<string, unknown>> => {
            currentAccount();
            try {
                const response = await tynn!.request(path, { method, ...(body === undefined ? {} : { body }) });
                currentAccount();
                if (!response.ok) throw new ProvisionFailure(response.status >= 500 ? 'offline' : 'refused', `Tynn refused the agent request (${response.status}).`);
                const value = object(await response.json()); currentAccount();
                if (!value) throw new ProvisionFailure('refused', 'Tynn returned invalid agent data.');
                return value;
            } catch (error) {
                if (error instanceof ProvisionFailure) throw error;
                throw new ProvisionFailure('offline', 'Tynn could not be reached. No other agent credential was used.');
            }
        };
        const path = `/api/v1/projects/${encodeURIComponent(projectId)}/agents`;
        const list = await api(path, 'GET');
        if (list.project_id !== projectId || !Array.isArray(list.agents)) throw new ProvisionFailure('conflict', 'Tynn returned agents for an unexpected project.');
        const agents = list.agents.map(remoteAgent);
        if (agents.some((a) => a === null)) throw new ProvisionFailure('refused', 'Tynn returned invalid agent identities.');
        const matches = agents.filter((a) => a?.external_id === agent.id) as RemoteAgent[];
        if (matches.length > 1) throw new ProvisionFailure('conflict', 'Tynn returned duplicate bindings for this Genie agent.');
        let remote = matches[0];
        if (known && (!remote || remote.id !== known.remoteAgentId)) throw new ProvisionFailure('conflict', 'The stored Tynn agent identity no longer matches this project.');
        if (!remote) {
            if (agents.some((a) => a!.name.toLowerCase() === agent.name.toLowerCase())) throw new ProvisionFailure('conflict', 'Another Tynn agent already uses this name. Resolve the identity conflict before provisioning.');
            const registered = await api(path, 'POST', { name: agent.name, external_id: agent.id, config: {
                provider: agent.provider, ...(agent.model ? { model: agent.model } : {}),
                ...(agent.instructions ? { instructions: agent.instructions } : {}), permissions: [permissions], mode: agent.mode,
            } });
            remote = remoteAgent(registered.agent) ?? undefined;
            if (!remote || remote.external_id !== agent.id) throw new ProvisionFailure('conflict', 'Tynn did not confirm this agent identity.');
        }
        if (remote.status !== 'active') throw new ProvisionFailure('inactive', `This Tynn agent is ${remote.status}; it cannot receive or use a credential.`);
        if (known?.state === 'pending') throw new ProvisionFailure('pending', 'An earlier key request is unconfirmed. Review this agent’s keys in Tynn before issuing another.');
        if (known) {
            const live = remote.tokens.find((t) => t.public_id.toLowerCase() === known.publicId?.toLowerCase());
            if (!live?.active || (live.scope_target !== undefined && live.scope_target !== 'mcp')) throw new ProvisionFailure('inactive', 'This agent’s Tynn key was revoked, expired or changed. Explicit renewal is required.');
            let token: string;
            try { token = ports.cipher.decrypt(Buffer.from(known.tokenEnc ?? '', 'base64')); }
            catch { throw new ProvisionFailure('storage', 'This agent’s Tynn key cannot be unlocked. No replacement was minted.'); }
            if (RPK.exec(token)?.[1]?.toLowerCase() !== known.publicId?.toLowerCase()) throw new ProvisionFailure('storage', 'The stored Tynn agent key is invalid.');
            currentAccount();
            return { status: 'already', mcp: { url: MCP_URL, token }, remoteAgentId: remote.id };
        }
        const binding: Stored = { userId, projectId, genieId: agent.id, remoteAgentId: remote.id, state: 'pending' };
        // Persist intent before a non-idempotent mint. A lost response or crash must not multiply live keys.
        await save(key, binding);
        const minted = await api('/api/v1/projects/agent-token', 'POST', { project_id: projectId, agent_name: remote.name });
        const principal = object(minted.agent);
        const token = typeof minted.token === 'string' ? minted.token : '';
        const publicId = RPK.exec(token)?.[1];
        if (principal?.id !== remote.id || !publicId || minted.mcp_url !== MCP_URL || (minted.scope_target !== undefined && minted.scope_target !== 'mcp')) {
            throw new ProvisionFailure('pending', 'Tynn did not confirm the expected agent key. Review the pending key before trying again.');
        }
        currentAccount();
        let tokenEnc: string;
        try { tokenEnc = ports.cipher.encrypt(token).toString('base64'); }
        catch { throw new ProvisionFailure('pending', 'The issued Tynn key could not be encrypted. Review the pending key before trying again.'); }
        await save(key, { ...binding, state: 'ready', publicId, tokenEnc });
        currentAccount();
        return { status: 'minted', mcp: { url: MCP_URL, token }, remoteAgentId: remote.id };
    }

    return {
        ensure(input: { projectId: string; agent: AgentRecord; tynn: TynnSessionPort | null }): Promise<TynnAgentToken> {
            const userId = input.tynn?.userId?.();
            if (!userId || !input.tynn?.status().signedIn) return Promise.resolve({ status: 'failed', code: 'refused', reason: 'Sign in to Tynn before provisioning an agent credential.' });
            const key = JSON.stringify([userId, input.projectId, input.agent.id]);
            const pending = inFlight.get(key); if (pending) return pending;
            // Tynn upserts by case-insensitive name. Different local ids share that namespace, so serializing only
            // identical ids would still let two name-colliding registrations overwrite each other.
            const project = JSON.stringify([userId, input.projectId]);
            const before = projects.get(project) ?? Promise.resolve();
            const run = () => decide(input, userId, key);
            const work = before.then(run, run).catch((error: unknown): TynnAgentToken => ({
                status: 'failed', code: error instanceof ProvisionFailure ? error.code : 'storage',
                reason: error instanceof ProvisionFailure ? error.message : 'Tynn agent provisioning could not be completed. No other credential was used.',
            })).finally(() => { inFlight.delete(key); if (projects.get(project) === work) projects.delete(project); });
            projects.set(project, work); inFlight.set(key, work); return work;
        },
    };
}
