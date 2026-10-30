import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AppSource, AppSourceKind } from '../core/app-inbox.js';
import { runtimeDir } from './paths.js';
import { readJson, writeJsonAtomic } from './store.js';

/**
 * THE APP KEYS (genie#1345) — the credentials an app presents at the app door, each of which IS an identity.
 *
 * - A SITE's or a kept PROCESS's token is minted by Genie, handed only to that one's own start-up env, and lives in this
 *   process's memory for the run: nothing on disk can be replayed, and a new run mints new ones (Genie restarts its
 *   sites and processes with the new env at start, as it does for any env change).
 * - A SCRIPT key is created by the person for a script outside Genie (the owner's D3: shown once, revocable, one
 *   workspace, listed in Settings). Only its sha256 is kept, so it resolves across restarts and the file holds no secret.
 * - A source the person REVOKED is remembered (`revoked`), so it gets no token on its next start or after a restart,
 *   until they Allow it again.
 *
 * Lookup is by the token's hash, so the token itself is never compared character by character.
 */

const FILE = 'app-inbox.json';
const TOKEN_PREFIX = 'gik_';
const NAME = /^[A-Za-z0-9._-]{1,48}$/;

interface ScriptKeyRecord {
    readonly id: string;
    readonly name: string;
    readonly workspaceId: string;
    readonly sha256: string;
    readonly createdAt: string;
    readonly lastUsedAt: string | null;
}

interface RevokedRecord {
    readonly kind: Exclude<AppSourceKind, 'script'>;
    readonly id: string;
    readonly workspaceId: string;
    readonly name?: string;
}

interface KeysFile {
    scriptKeys: ScriptKeyRecord[];
    revoked: RevokedRecord[];
}

export interface ScriptKeyView {
    readonly id: string;
    readonly name: string;
    readonly createdAt: string;
    readonly lastUsedAt: string | null;
}

export interface AppInboxKeysOptions {
    readonly now?: () => string;
    readonly random?: (bytes: number) => Buffer;
}

const hash = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');
const sourceKey = (kind: string, id: string): string => `${kind}:${id}`;

export class AppInboxKeys {
    readonly #file: string;
    #data: KeysFile;
    readonly #now: () => string;
    readonly #random: (bytes: number) => Buffer;
    /** A site's or process's live token: source key → { token, source }. Memory only. */
    readonly #issued = new Map<string, { token: string; source: AppSource }>();
    /** hash → what it resolves to: the issued tokens and every script key. */
    readonly #byHash = new Map<string, { kind: 'issued'; key: string } | { kind: 'script'; id: string }>();

    private constructor(file: string, data: KeysFile, options: AppInboxKeysOptions) {
        this.#file = file;
        this.#data = data;
        this.#now = options.now ?? (() => new Date().toISOString());
        this.#random = options.random ?? ((n) => randomBytes(n));
        for (const k of data.scriptKeys) this.#byHash.set(k.sha256, { kind: 'script', id: k.id });
    }

    static async open(userData: string, options: AppInboxKeysOptions = {}): Promise<AppInboxKeys> {
        const file = join(runtimeDir(userData), FILE);
        const raw = await readJson<Partial<KeysFile>>(file, {});
        const data: KeysFile = {
            scriptKeys: Array.isArray(raw.scriptKeys) ? raw.scriptKeys.filter((k): k is ScriptKeyRecord => typeof k?.sha256 === 'string' && typeof k?.id === 'string' && typeof k?.workspaceId === 'string') : [],
            revoked: Array.isArray(raw.revoked) ? raw.revoked.filter((r): r is RevokedRecord => (r?.kind === 'site' || r?.kind === 'process') && typeof r?.id === 'string') : [],
        };
        return new AppInboxKeys(file, data, options);
    }

    #mint(): string {
        return `${TOKEN_PREFIX}${this.#random(32).toString('base64url')}`;
    }

    /**
     * The token a site or a kept process starts with — minted on first ask, the same for the rest of the run (its name
     * kept current). `null` when the person revoked it. Only sites and processes are minted this way.
     */
    tokenFor(source: AppSource): string | null {
        if (source.kind === 'script') throw new Error('a script key is created by the person (createScriptKey), never minted for a source');
        if (this.#isRevoked(source.kind, source.id)) return null;
        const key = sourceKey(source.kind, source.id);
        const issued = this.#issued.get(key);
        if (issued) {
            if (issued.source.name !== source.name || issued.source.workspaceId !== source.workspaceId) this.#issued.set(key, { token: issued.token, source: { ...source } });
            return issued.token;
        }
        const token = this.#mint();
        this.#issued.set(key, { token, source: { ...source } });
        this.#byHash.set(hash(token), { kind: 'issued', key });
        return token;
    }

    /** A new token for the source; the old one is dead at once. Its next start (Genie restarts it) gets the new one. */
    rotate(kind: AppSourceKind, id: string): void {
        this.#drop(sourceKey(kind, id));
    }

    /** Dead at once, and no token on any later start — across restarts — until `allowSource`. */
    async revokeSource(source: { readonly kind: AppSourceKind; readonly id: string; readonly workspaceId: string; readonly name?: string }): Promise<void> {
        if (source.kind === 'script') throw new Error('a script key is revoked with revokeScriptKey');
        const issued = this.#issued.get(sourceKey(source.kind, source.id));
        this.#drop(sourceKey(source.kind, source.id));
        if (!this.#isRevoked(source.kind, source.id)) {
            const name = source.name ?? issued?.source.name;
            this.#data = { ...this.#data, revoked: [...this.#data.revoked, { kind: source.kind, id: source.id, workspaceId: source.workspaceId, ...(name ? { name } : {}) }] };
            await this.#flush();
        }
    }

    async allowSource(kind: AppSourceKind, id: string): Promise<void> {
        const before = this.#data.revoked.length;
        this.#data = { ...this.#data, revoked: this.#data.revoked.filter((r) => !(r.kind === kind && r.id === id)) };
        if (this.#data.revoked.length !== before) await this.#flush();
    }

    /** The sources holding a live token in a workspace. */
    sources(workspaceId: string): Array<{ kind: AppSourceKind; id: string; name: string }> {
        return [...this.#issued.values()].filter((i) => i.source.workspaceId === workspaceId).map((i) => ({ kind: i.source.kind, id: i.source.id, name: i.source.name }));
    }

    revokedSources(workspaceId: string): Array<{ kind: AppSourceKind; id: string; name?: string }> {
        return this.#data.revoked.filter((r) => r.workspaceId === workspaceId).map((r) => ({ kind: r.kind, id: r.id, ...(r.name ? { name: r.name } : {}) }));
    }

    /** A new script key for one workspace. The token is returned ONCE; only its hash is kept. */
    async createScriptKey(workspaceId: string, rawName: string): Promise<{ id: string; token: string }> {
        const name = rawName.trim();
        if (!NAME.test(name)) throw new Error('a key’s name is 1–48 letters, digits, dots, dashes or underscores');
        if (this.#data.scriptKeys.some((k) => k.workspaceId === workspaceId && k.name.toLowerCase() === name.toLowerCase())) {
            throw new Error(`this workspace already has a key named ${name}; revoke it or pick another name`);
        }
        const token = this.#mint();
        const record: ScriptKeyRecord = { id: `key_${randomUUID()}`, name, workspaceId, sha256: hash(token), createdAt: this.#now(), lastUsedAt: null };
        this.#data = { ...this.#data, scriptKeys: [...this.#data.scriptKeys, record] };
        await this.#flush();
        this.#byHash.set(record.sha256, { kind: 'script', id: record.id });
        return { id: record.id, token };
    }

    async revokeScriptKey(id: string): Promise<boolean> {
        const record = this.#data.scriptKeys.find((k) => k.id === id);
        if (!record) return false;
        this.#byHash.delete(record.sha256);
        this.#data = { ...this.#data, scriptKeys: this.#data.scriptKeys.filter((k) => k.id !== id) };
        await this.#flush();
        return true;
    }

    scriptKeys(workspaceId: string): ScriptKeyView[] {
        return this.#data.scriptKeys.filter((k) => k.workspaceId === workspaceId).map((k) => ({ id: k.id, name: k.name, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt }));
    }

    /** Who a presented token is, or `null`: unknown, rotated, revoked — all the same answer. */
    resolve(token: string): AppSource | null {
        if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
        const hit = this.#byHash.get(hash(token));
        if (!hit) return null;
        if (hit.kind === 'issued') {
            const issued = this.#issued.get(hit.key);
            return issued && issued.token === token ? { ...issued.source } : null;
        }
        const record = this.#data.scriptKeys.find((k) => k.id === hit.id);
        return record ? { kind: 'script', id: record.id, name: record.name, workspaceId: record.workspaceId } : null;
    }

    /** A script key was used: when, for the person's list. */
    async used(source: AppSource): Promise<void> {
        if (source.kind !== 'script') return;
        const at = this.#now();
        this.#data = { ...this.#data, scriptKeys: this.#data.scriptKeys.map((k) => (k.id === source.id ? { ...k, lastUsedAt: at } : k)) };
        await this.#flush();
    }

    #isRevoked(kind: string, id: string): boolean {
        return this.#data.revoked.some((r) => r.kind === kind && r.id === id);
    }

    #drop(key: string): void {
        const issued = this.#issued.get(key);
        if (!issued) return;
        this.#byHash.delete(hash(issued.token));
        this.#issued.delete(key);
    }

    #flush(): Promise<void> {
        return writeJsonAtomic(this.#file, this.#data);
    }
}
