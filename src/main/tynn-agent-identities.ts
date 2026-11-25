import { readFile } from 'node:fs/promises';
import { isAcpProvider } from '../core/engine.js';
import type { AgentRecord } from '../core/identity.js';
import { TYNN_HOST } from '../core/tynn.js';
import type { TynnAgentToken, TynnSessionPort } from './tynn-agent-token.js';
import type { KeychainRead, KeychainResult, SecretName } from './keychain.js';
import type { MigrationSource, OldRead } from './keychain-migration.js';
import { preparePrivateCredential, writePrivateCredential } from './private-credentials.js';

/**
 * WHERE AN AGENT'S KEY IS HELD: the host's keychain (P3.4, genie#1457). Only the host reaches it (`Keychain` is this port);
 * since Tynn #961 no window does. Named by the key's public id, which is no secret.
 */
export interface AgentSecrets {
    probe(): Promise<KeychainResult>;
    get(name: SecretName): Promise<KeychainRead>;
    set(name: SecretName, value: string): Promise<KeychainResult>;
}
export interface AgentCredentialPorts {
    readonly file: string;
    readonly secrets: AgentSecrets;
    /**
     * Is this id one of THIS machine's agents (the registry)? A Tynn agent whose Genie id is here belongs to another local
     * agent, and is never mounted by a second one (Tynn #1016). Absent = only the vault's own bindings say so.
     */
    readonly isLocalAgent?: (id: string) => boolean;
}
/** The settings Tynn holds for an agent, as Genie keeps them: what a mounting machine applies (Tynn #1016). */
export interface TynnAgentSettings {
    readonly permissions?: 'all' | 'ask' | 'edits';
    readonly mode?: 'automated' | 'manual';
    readonly autoApprove?: boolean;
    readonly accessScope?: AgentRecord['accessScope'];
    readonly model?: string;
}
/** An agent's settings as Tynn's config holds them (Tynn AgentConfig: a closed set of keys). Sent on register and on change. */
export function tynnConfigOf(agent: AgentRecord): Record<string, unknown> {
    return {
        provider: agent.provider, ...(agent.model ? { model: agent.model } : {}),
        ...(agent.instructions ? { instructions: agent.instructions } : {}), permissions: [agent.permissions ?? 'all'], mode: agent.mode,
        auto_approve: agent.autoApprove === true, access_scope: agent.accessScope,
    };
}
const ACCESS_SCOPES: ReadonlySet<string> = new Set(['none', 'self', 'specific', 'all']);
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
    /** An older Genie's safeStorage copy of the key, until the migration deletes it. Nothing reads it but `legacyKeys`. */
    readonly tokenEnc?: string;
}
interface RemoteAgent {
    readonly id: string;
    readonly name: string;
    readonly external_id: string | null;
    readonly status: 'active' | 'suspended' | 'archived';
    readonly tokens: readonly { readonly public_id: string; readonly active: boolean; readonly scope_target?: string }[];
    readonly config?: unknown;
}
const agentEntry = (publicId: string): SecretName => `tynn/agent/${publicId}`;
const MCP_URL = `${TYNN_HOST}/mcp/tynn`;
const RPK = /^rpk_([0-9A-HJKMNP-TV-Z]{26})\.[a-f0-9]{64}$/i;
const object = (value: unknown): Record<string, unknown> | null => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
/** What of Tynn's config this agent takes: only values Genie knows, and a model only for the provider it names. */
function settingsFrom(config: unknown, agent: AgentRecord): TynnAgentSettings {
    const c = object(config) ?? {};
    const permission = Array.isArray(c.permissions) && c.permissions.length === 1 ? c.permissions[0] : undefined;
    return {
        ...(permission === 'all' || permission === 'ask' || permission === 'edits' ? { permissions: permission } : {}),
        ...(c.mode === 'automated' || c.mode === 'manual' ? { mode: c.mode } : {}),
        ...(typeof c.auto_approve === 'boolean' ? { autoApprove: c.auto_approve } : {}),
        ...(typeof c.access_scope === 'string' && ACCESS_SCOPES.has(c.access_scope) ? { accessScope: c.access_scope as AgentRecord['accessScope'] } : {}),
        ...(typeof c.model === 'string' && c.model.trim() && !c.model.startsWith('-') && c.provider === agent.provider ? { model: c.model } : {}),
    };
}
function remoteAgent(value: unknown): RemoteAgent | null {
    const row = object(value);
    if (!row || typeof row.id !== 'string' || !row.id || typeof row.name !== 'string' || !row.name.trim()
        || (row.external_id !== null && typeof row.external_id !== 'string') || !['active', 'suspended', 'archived'].includes(String(row.status)) || !Array.isArray(row.tokens)) return null;
    if (row.tokens.some((token) => { const t = object(token); return !t || typeof t.public_id !== 'string' || typeof t.active !== 'boolean'; })) return null;
    return row as unknown as RemoteAgent;
}

/** Main-process vault and identity provisioner. No project file supplies or receives an agent credential. */
export function tynnAgentIdentities(ports: AgentCredentialPorts) {
    /** The file's permissions are made right once. Its contents are read each time: another process may write it (the one-time move). */
    let prepared = false;
    let writes: Promise<unknown> = Promise.resolve();
    const inFlight = new Map<string, Promise<TynnAgentToken>>();
    const projects = new Map<string, Promise<TynnAgentToken>>();

    const load = async (): Promise<Record<string, Stored>> => {
        let text: string;
        try {
            if (!prepared) { await preparePrivateCredential(ports.file); prepared = true; }
            text = await readFile(ports.file, 'utf8');
        }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new ProvisionFailure('storage', 'The private Tynn agent vault could not be read.'); }
        try {
            const parsed = object(JSON.parse(text));
            const records = object(parsed?.records);
            if (parsed?.version !== 1 || !records) throw new Error();
            return records as unknown as Record<string, Stored>;
        } catch { throw new ProvisionFailure('storage', 'The private Tynn agent vault is invalid; no new key was requested.'); }
    };

    const save = (key: string, record: Stored): Promise<void> => {
        const run = async () => {
            const next = { ...await load(), [key]: record };
            try {
                await writePrivateCredential(ports.file, JSON.stringify({ version: 1, records: next }));
            } catch { throw new ProvisionFailure('storage', 'The private Tynn agent vault could not be saved. Review any pending key before trying again.'); }
        };
        const work = writes.then(run, run); writes = work.catch(() => {}); return work;
    };

    /** The stored key, from the keychain and checked against its own public id; never a replacement. */
    const unlock = async (known: Stored): Promise<string> => {
        if (!known.publicId) throw new ProvisionFailure('storage', 'The stored Tynn agent key is invalid.');
        const read = await ports.secrets.get(agentEntry(known.publicId));
        if (read.kind !== 'value') throw new ProvisionFailure('storage', 'This agent’s Tynn key cannot be read from the keychain. No replacement was minted.');
        if (RPK.exec(read.value)?.[1]?.toLowerCase() !== known.publicId.toLowerCase()) throw new ProvisionFailure('storage', 'The stored Tynn agent key is invalid.');
        return read.value;
    };
    const keychainAnswers = async (message: string): Promise<void> => {
        if (!(await ports.secrets.probe()).ok) throw new ProvisionFailure('storage', message);
    };

    /**
     * OFF GRID (genie#1234): this agent's own READY key from the vault, with no round trip to Tynn — for when Genie is not
     * signed in yet (the saved account, unconfirmed this launch) or Tynn cannot be reached. Nothing is registered or minted
     * here, the key is bound to this account, project and agent, and it is marked unverified so it is checked with Tynn
     * once Tynn answers. Tynn itself still refuses a revoked key whenever the agent uses it.
     */
    async function stored(input: { projectId: string; agent: AgentRecord; signal?: AbortSignal }, userId: string, key: string): Promise<TynnAgentToken> {
        if (input.signal?.aborted) throw new ProvisionFailure('refused', 'Tynn agent credential preparation was cancelled.');
        await keychainAnswers('Unlock the keychain before using a Tynn agent credential.');
        const records = await load();
        const known = records[key];
        if (!Object.hasOwn(records, key)) throw new ProvisionFailure('refused', 'Sign in to Tynn before provisioning an agent credential.');
        if (!known || !object(known) || known.userId !== userId || known.projectId !== input.projectId || known.genieId !== input.agent.id || typeof known.remoteAgentId !== 'string' || !['pending', 'ready'].includes(known.state)) {
            throw new ProvisionFailure('storage', 'The stored Tynn agent binding is invalid.');
        }
        if (known.state !== 'ready') throw new ProvisionFailure('pending', 'An earlier key request is unconfirmed. Review this agent’s keys in Tynn before issuing another.');
        return { status: 'already', mcp: { url: MCP_URL, token: await unlock(known) }, remoteAgentId: known.remoteAgentId, unverified: true };
    }

    async function decide(input: { projectId: string; agent: AgentRecord; tynn: TynnSessionPort | null; signal?: AbortSignal }, userId: string, key: string): Promise<TynnAgentToken> {
        const { projectId, agent, tynn } = input;
        await keychainAnswers('Unlock the keychain before provisioning a Tynn agent.');
        const currentAccount = () => {
            if (input.signal?.aborted) throw new ProvisionFailure('refused', 'Tynn agent credential preparation was cancelled.');
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
        const api = async (path: string, method: 'GET' | 'POST' | 'PATCH', body?: unknown): Promise<Record<string, unknown>> => {
            currentAccount();
            try {
                const response = await tynn!.request(path, { method, ...(body === undefined ? {} : { body }), ...(input.signal ? { signal: input.signal } : {}) });
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
        /** Another binding in this vault, for this person and project, to that Tynn agent: a local twin holds it. */
        const heldByAnother = (remoteId: string) => Object.entries(records).some(([k, r]) => k !== key && object(r) && r.remoteAgentId === remoteId && r.userId === userId && r.projectId === projectId);
        // MOUNTED (Tynn #1016): the binding this vault holds names Tynn's agent by its id, whatever Genie id Tynn has on it
        // (the machine that registered it).
        if (!remote && known) remote = (agents as RemoteAgent[]).find((a) => a.id === known.remoteAgentId && !heldByAnother(a.id));
        if (known && (!remote || remote.id !== known.remoteAgentId)) throw new ProvisionFailure('conflict', 'The stored Tynn agent identity no longer matches this project.');
        let adopted: TynnAgentSettings | undefined;
        if (!remote) {
            const named = agents.filter((a) => a!.name.toLowerCase() === agent.name.toLowerCase()) as RemoteAgent[];
            const same = named.length === 1 && named[0]!.name === agent.name && named[0]!.external_id !== null ? named[0]! : undefined;
            /*
             * THE SHARED AGENT (Tynn #1016; the owner's ruling #1003: agents belong to the workspace, keys are minted per
             * person on mount). Tynn's agent of exactly this name, registered by ANOTHER machine, is this agent: it gets a key
             * of its own and the settings Tynn holds. Never when that agent is one of THIS machine's own (two local agents
             * never share one Tynn identity), and never a name that differs only in case.
             */
            const local = same !== undefined && (ports.isLocalAgent?.(same.external_id!) === true || heldByAnother(same.id));
            if (same && !local) {
                remote = same;
                adopted = settingsFrom(same.config, agent);
            } else {
                if (named.length > 0) throw new ProvisionFailure('conflict', 'Another Tynn agent already uses this name. Resolve the identity conflict before provisioning.');
                const registered = await api(path, 'POST', { name: agent.name, external_id: agent.id, config: tynnConfigOf({ ...agent, permissions }) });
                remote = remoteAgent(registered.agent) ?? undefined;
                if (!remote || remote.external_id !== agent.id) throw new ProvisionFailure('conflict', 'Tynn did not confirm this agent identity.');
            }
        }
        if (remote.status !== 'active') throw new ProvisionFailure('inactive', `This Tynn agent is ${remote.status}; it cannot receive or use a credential.`);
        if (known?.state === 'pending') throw new ProvisionFailure('pending', 'An earlier key request is unconfirmed. Review this agent’s keys in Tynn before issuing another.');
        if (known) {
            const live = remote.tokens.find((t) => t.public_id.toLowerCase() === known.publicId?.toLowerCase());
            if (!live?.active || (live.scope_target !== undefined && live.scope_target !== 'mcp')) throw new ProvisionFailure('inactive', 'This agent’s Tynn key was revoked, expired or changed. Explicit renewal is required.');
            const token = await unlock(known);
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
        const held = await ports.secrets.set(agentEntry(publicId), token).catch(() => ({ ok: false }));
        if (!held.ok) throw new ProvisionFailure('pending', 'The issued Tynn key could not be kept in the keychain. Review the pending key before trying again.');
        await save(key, { ...binding, state: 'ready', publicId });
        currentAccount();
        return { status: 'minted', mcp: { url: MCP_URL, token }, remoteAgentId: remote.id, ...(adopted ? { adopted } : {}) };
    }

    /**
     * A LATER SETTING CHANGE, SENT (Tynn #1001): this agent's settings to the Tynn agent this vault binds it to (the one it
     * registered, or the shared one it mounted). Only when signed in as the binding's person and the binding is ready;
     * `unbound` = nothing to send to (its first start registers it with its settings).
     */
    async function push(input: { projectId: string; agent: AgentRecord; tynn: TynnSessionPort | null }): Promise<'sent' | 'unbound' | 'failed'> {
        const tynn = input.tynn;
        const userId = tynn?.status().signedIn ? tynn.userId?.() : null;
        if (!tynn || !userId) return 'failed';
        let known: Stored | undefined;
        try { known = (await load())[JSON.stringify([userId, input.projectId, input.agent.id])]; } catch { return 'failed'; }
        if (!known || !object(known) || known.state !== 'ready' || typeof known.remoteAgentId !== 'string' || known.genieId !== input.agent.id) return 'unbound';
        try {
            const response = await tynn.request(`/api/v1/projects/${encodeURIComponent(input.projectId)}/agents/${encodeURIComponent(known.remoteAgentId)}`, { method: 'PATCH', body: { config: tynnConfigOf(input.agent) } });
            return response.ok ? 'sent' : 'failed';
        } catch { return 'failed'; }
    }

    return {
        push,
        /** The keys an older Genie sealed with safeStorage, for the one-time move (keychain-migration.ts). Only a window can open them. */
        async legacyKeys(cipher: { decrypt(bytes: Buffer): string }): Promise<MigrationSource[]> {
            const records = await load();
            return Object.entries(records).filter(([, row]) => object(row) && typeof row.tokenEnc === 'string' && typeof row.publicId === 'string').map(([key, row]) => ({
                name: agentEntry(row.publicId!),
                old: {
                    read: async (): Promise<OldRead> => {
                        const now = (await load())[key];
                        if (!now?.tokenEnc) return { kind: 'none' };
                        try {
                            const token = cipher.decrypt(Buffer.from(now.tokenEnc, 'base64'));
                            return RPK.exec(token)?.[1]?.toLowerCase() === now.publicId?.toLowerCase() ? { kind: 'value', value: token } : { kind: 'unreadable' };
                        } catch { return { kind: 'unreadable' }; }
                    },
                    remove: async (): Promise<void> => {
                        const now = (await load())[key];
                        if (!now) return;
                        const { tokenEnc: _gone, ...kept } = now;
                        await save(key, kept);
                    },
                },
            }));
        },
        /**
         * KEYS THE KEYCHAIN LOST (P7.3: a rebuilt machine has an empty keychain). `ids`: the public ids on record as ready,
         * for whoever asks the keychain whether each is held. `forget`: THE EXPLICIT RENEWAL the rest of this file asks for:
         * the person said to make new keys, so each ready record whose key the keychain answers is MISSING (never one it
         * could not read) is taken off record; that agent's next `ensure` finds its identity in Tynn and mints one key, by
         * the same path as a first key. The lost key is not revoked here: it stays listed in Tynn until the person does.
         */
        lostKeys: {
            async ids(): Promise<string[]> {
                const records = await load();
                return Object.values(records).filter((r) => object(r) && r.state === 'ready' && typeof r.publicId === 'string').map((r) => r.publicId!);
            },
            forget(): Promise<number> {
                const run = async (): Promise<number> => {
                    if (!(await ports.secrets.probe()).ok) return 0;
                    const records = await load();
                    const kept: Record<string, Stored> = {};
                    let lost = 0;
                    for (const [key, record] of Object.entries(records)) {
                        if (object(record) && record.state === 'ready' && typeof record.publicId === 'string' && (await ports.secrets.get(agentEntry(record.publicId))).kind === 'missing') { lost += 1; continue; }
                        kept[key] = record;
                    }
                    if (lost > 0) {
                        try { await writePrivateCredential(ports.file, JSON.stringify({ version: 1, records: kept })); }
                        catch { throw new ProvisionFailure('storage', 'The private Tynn agent vault could not be saved. No key was made again.'); }
                    }
                    return lost;
                };
                const work = writes.then(run, run); writes = work.catch(() => {}); return work;
            },
        },
        ensure(input: { projectId: string; agent: AgentRecord; tynn: TynnSessionPort | null; signal?: AbortSignal }): Promise<TynnAgentToken> {
            // Signed in: Tynn is asked first, as always. Not (yet) signed in: only the saved account's stored key (genie#1234).
            const signedIn = input.tynn?.status().signedIn === true;
            const userId = signedIn ? input.tynn?.userId?.() : input.tynn?.savedUserId?.();
            if (!userId) return Promise.resolve({ status: 'failed', code: 'refused', reason: 'Sign in to Tynn before provisioning an agent credential.' });
            const key = JSON.stringify([userId, input.projectId, input.agent.id]);
            const pending = inFlight.get(key); if (pending) return pending;
            // Tynn upserts by case-insensitive name. Different local ids share that namespace, so serializing only
            // identical ids would still let two name-colliding registrations overwrite each other.
            const project = JSON.stringify([userId, input.projectId]);
            const before = projects.get(project) ?? Promise.resolve();
            // Tynn unreachable (network, 5xx) is the only failure the stored key answers; a refusal Tynn GAVE stands.
            const run = signedIn
                ? () => decide(input, userId, key).catch((error: unknown) => {
                    if (!(error instanceof ProvisionFailure) || error.code !== 'offline' || input.signal?.aborted) throw error;
                    return stored(input, userId, key).catch(() => { throw error; });
                })
                : () => stored(input, userId, key);
            const work = before.then(run, run).catch((error: unknown): TynnAgentToken => ({
                status: 'failed', code: error instanceof ProvisionFailure ? error.code : 'storage',
                reason: error instanceof ProvisionFailure ? error.message : 'Tynn agent provisioning could not be completed. No other credential was used.',
            })).finally(() => { inFlight.delete(key); if (projects.get(project) === work) projects.delete(project); });
            projects.set(project, work); inFlight.set(key, work); return work;
        },
    };
}
