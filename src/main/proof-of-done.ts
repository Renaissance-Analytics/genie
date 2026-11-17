import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { canonicalize } from '../core/jcs.js';
import type { KeychainRead, KeychainResult, SecretName } from './keychain.js';

/**
 * PROOF-OF-DONE, THE HOST'S HALF (Tynn #742; the owner, 2026-11-15: "the genie host signs on behalf of the logged in tynn
 * user on the host machine"). One Ed25519 key per host. Its private half lives in the OS credential store and nowhere
 * else: no file, no log line, no workspace. Its public half is registered with the signed-in person's Tynn. Tynn then lists
 * the claims waiting for this key; the host checks each claim's hash is the SHA-256 of the claim's canonical form (RFC 8785)
 * and signs the 32 bytes — alone when Tynn says an agent's Done may be signed by the agent, after the person's Sign when it
 * says HITL. A signed PoD is written as a git note on each attested commit and the notes ref is pushed.
 *
 * NOTHING HERE BLOCKS. A failed request, a commit that is not here yet, a push that has no route: each is said in the log,
 * kept for the next poll, and never stops the next claim.
 */

export const POD_KEY_SECRET: SecretName = 'pod/host-key';
export const POD_NOTES_REF = 'refs/notes/proof-of-done';
/** A note that could not be written or pushed is given up on after this long. */
const RETRY_FOR_MS = 14 * 24 * 60 * 60 * 1000;

/** Hex of the first 16 bytes of SHA-256 of the raw 32-byte public key — Tynn's `key_id`. */
export function podKeyId(rawPublicKey: Uint8Array): string {
    return createHash('sha256').update(rawPublicKey).digest().subarray(0, 16).toString('hex');
}

/** A git note still to be written (`note`) or its notes ref still to be pushed (`push`). */
export interface PendingNote {
    readonly stage: 'note' | 'push';
    readonly sha: string;
    readonly text: string;
    /** The repository the note is in, once found (always for `push`). */
    readonly path: string | null;
    readonly at: number;
}

type Response = { ok: boolean; status: number; json(): Promise<unknown> };
type GitResult = { readonly ok: boolean; readonly stdout: string; readonly error?: string };

export interface PodPorts {
    readonly keychain: {
        get(name: SecretName): Promise<KeychainRead>;
        set(name: SecretName, value: string): Promise<KeychainResult>;
    };
    readonly tynn: {
        signedIn(): boolean;
        userId(): string | null;
        request(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<Response>;
    };
    /** The person's Sign / Decline for one HITL claim: `detail` names the task, the score and the commits. */
    approve(request: { readonly id: string; readonly detail: string }): Promise<'allowed' | 'denied'>;
    workspaces(): readonly { readonly id: string; readonly path: string }[];
    git(cwd: string, args: readonly string[]): Promise<GitResult>;
    /** What is still owed to git, kept across restarts. */
    readonly retry: { load(): Promise<PendingNote[]>; save(notes: PendingNote[]): Promise<void> };
    label(): string;
    log(line: string): void;
    now?(): number;
}

interface Held { readonly privateKey: KeyObject; readonly raw: Buffer; readonly keyId: string }

const SHA = /^[0-9a-f]{7,64}$/i;
const said = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const rawPublic = (privateKey: KeyObject): Buffer => Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x as string, 'base64url');

export class ProofOfDone {
    readonly #ports: PodPorts;
    #held: Held | null = null;
    #registeredFor: string | null = null;
    #refusedFor: string | null = null;
    #told = new Set<string>();
    /** Every claim answered or being answered this run: Tynn's list is asked again each poll. */
    readonly #handled = new Set<string>();
    readonly #inFlight = new Set<Promise<void>>();
    #retrying = false;

    constructor(ports: PodPorts) {
        this.#ports = ports;
    }

    #say(line: string, once?: string): void {
        if (once !== undefined) { if (this.#told.has(once)) return; this.#told.add(once); }
        this.#ports.log(`proof-of-done: ${line}`);
    }

    /** The key, from the credential store; made and kept there the first time. Null (and said) when the store would not keep it. */
    async #key(): Promise<Held | null> {
        if (this.#held) return this.#held;
        const read = await this.#ports.keychain.get(POD_KEY_SECRET);
        if (read.kind === 'unavailable') { this.#say('the credential store did not answer, so no signing key is kept or used', 'store'); return null; }
        let privateKey: KeyObject;
        if (read.kind === 'value') {
            try { privateKey = createPrivateKey({ key: Buffer.from(read.value, 'base64url'), format: 'der', type: 'pkcs8' }); }
            catch { this.#say('the kept signing key could not be read, so nothing is signed', 'unreadable'); return null; }
        } else {
            privateKey = generateKeyPairSync('ed25519').privateKey;
            const der = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
            const stored = await this.#ports.keychain.set(POD_KEY_SECRET, der);
            // A key the store would not keep is gone at the next start: never used, so nothing is registered that cannot sign later.
            if (!stored.ok) { this.#say('the credential store would not keep the signing key, so none is used', 'store'); return null; }
        }
        const raw = rawPublic(privateKey);
        this.#held = { privateKey, raw, keyId: podKeyId(raw) };
        return this.#held;
    }

    async #register(held: Held, userId: string): Promise<boolean> {
        if (this.#registeredFor === userId) return true;
        if (this.#refusedFor === userId) return false;
        const res = await this.#ports.tynn.request('/api/v1/pod/host-keys', { method: 'POST', body: { public_key: held.raw.toString('base64url'), label: this.#ports.label() } });
        if (res.ok) { this.#registeredFor = userId; this.#say(`host key ${held.keyId} registered with Tynn`); return true; }
        if (res.status === 422) this.#refusedFor = userId;
        this.#say(`Tynn did not take the host key (${res.status})`);
        return false;
    }

    /** One poll: register the key, finish what git is owed, then answer each claim waiting for this host. Claims are not awaited past starting them. */
    async tick(): Promise<void> {
        try {
            if (!this.#ports.tynn.signedIn()) return;
            const userId = this.#ports.tynn.userId();
            if (userId === null) return;
            const held = await this.#key();
            if (!held) return;
            if (!(await this.#register(held, userId))) return;
            await this.#retryNotes();
            const res = await this.#ports.tynn.request('/api/v1/pod/pending', { method: 'GET' });
            if (!res.ok) { this.#say(`Tynn did not list the claims waiting (${res.status})`); return; }
            const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
            const items = Array.isArray(body?.data) ? body.data : [];
            for (const raw of items) {
                const item = raw as { id?: unknown; approval?: unknown; host_key_id?: unknown; claim?: unknown; claim_hash?: unknown };
                if (typeof item.id !== 'string' || item.host_key_id !== held.keyId || this.#handled.has(item.id)) continue;
                this.#handled.add(item.id);
                const work = this.#answer(held, item.id, item).catch((error: unknown) => {
                    // Not Tynn's answer: the network. The claim is still waiting, so the next poll tries it again.
                    this.#handled.delete(item.id as string);
                    this.#say(`claim ${String(item.id)} could not be answered: ${said(error)}`);
                });
                this.#inFlight.add(work);
                void work.finally(() => this.#inFlight.delete(work));
            }
        } catch (error) {
            this.#say(`poll failed: ${said(error)}`);
        }
    }

    /** Everything started so far has finished (a claim waiting on the person included). */
    async idle(): Promise<void> {
        while (this.#inFlight.size > 0) await Promise.all([...this.#inFlight]);
    }

    async #answer(held: Held, id: string, item: { approval?: unknown; claim?: unknown; claim_hash?: unknown }): Promise<void> {
        let canonical: string;
        try { canonical = canonicalize(item.claim); } catch { this.#say(`claim ${id} refused: it is not canonical JSON`); return; }
        const expected = createHash('sha256').update(canonical, 'utf8').digest();
        const given = typeof item.claim_hash === 'string' ? Buffer.from(item.claim_hash, 'base64url') : Buffer.alloc(0);
        if (given.length !== 32 || !given.equals(expected)) { this.#say(`claim ${id} refused: its hash is not the SHA-256 of its claim`); return; }

        if (item.approval === 'hitl') {
            const verdict = await this.#ports.approve({ id, detail: describe(item.claim) });
            if (verdict !== 'allowed') { this.#say(`claim ${id} not signed: the person declined`); return; }
        } else if (item.approval !== 'agent') {
            this.#say(`claim ${id} refused: unknown approval`);
            return;
        }

        const signature = sign(null, expected, held.privateKey).toString('base64url');
        const res = await this.#ports.tynn.request(`/api/v1/pod/${encodeURIComponent(id)}/signature`, { method: 'POST', body: { key_id: held.keyId, signature } });
        if (!res.ok) { this.#say(`Tynn did not take the signature for ${id} (${res.status})`); return; }
        const body = (await res.json().catch(() => null)) as { data?: { token?: unknown }; token?: unknown } | null;
        const token = body?.data?.token ?? body?.token;
        if (typeof token !== 'string' || token === '') { this.#say(`Tynn signed ${id} but sent no token, so no note is written`); return; }
        this.#say(`signed ${id}`);
        const text = `${token}\n${canonical}`;
        const at = (this.#ports.now ?? Date.now)();
        const owed = commitsOf(item.claim).map((sha): PendingNote => ({ stage: 'note', sha, text, path: null, at }));
        await this.#write(owed);
    }

    /** Write each note where its commit is, push what was written, and keep what could not be done. */
    async #write(notes: readonly PendingNote[]): Promise<void> {
        const kept: PendingNote[] = [];
        const pushed = new Set<string>();
        for (const note of notes) {
            let path = note.path;
            if (note.stage === 'note') {
                path = await this.#holder(note.sha);
                if (path === null) { kept.push(note); continue; }
                const added = await this.#ports.git(path, ['notes', '--ref=proof-of-done', 'add', '-f', '-m', note.text, note.sha]);
                if (!added.ok) { this.#say(`note on ${note.sha.slice(0, 7)} not written: ${added.error ?? 'git failed'}`); kept.push(note); continue; }
            }
            if (path !== null) pushed.add(path);
            else kept.push(note);
        }
        for (const path of pushed) {
            const result = await this.#ports.git(path, ['push', 'origin', `${POD_NOTES_REF}:${POD_NOTES_REF}`]);
            if (!result.ok) {
                this.#say(`notes not pushed from ${path}: ${result.error ?? 'git failed'}`);
                const at = (this.#ports.now ?? Date.now)();
                kept.push({ stage: 'push', sha: '', text: '', path, at });
            }
        }
        await this.#remember(kept);
    }

    async #holder(sha: string): Promise<string | null> {
        if (!SHA.test(sha)) return null;
        for (const workspace of this.#ports.workspaces()) {
            const has = await this.#ports.git(workspace.path, ['cat-file', '-e', `${sha}^{commit}`]);
            if (has.ok) return workspace.path;
        }
        return null;
    }

    async #remember(added: readonly PendingNote[]): Promise<void> {
        if (added.length === 0) return;
        try {
            const held = await this.#ports.retry.load();
            await this.#ports.retry.save([...held, ...added]);
        } catch (error) { this.#say(`could not keep what git is owed: ${said(error)}`); }
    }

    async #retryNotes(): Promise<void> {
        if (this.#retrying) return;
        this.#retrying = true;
        try {
            const owed = await this.#ports.retry.load();
            if (owed.length === 0) return;
            const now = (this.#ports.now ?? Date.now)();
            await this.#ports.retry.save([]);
            const live = owed.filter((n) => now - n.at < RETRY_FOR_MS);
            // One push per repository is enough, however many entries ask for it.
            const seen = new Set<string>();
            await this.#write(live.filter((n) => n.stage === 'note' || (n.path !== null && !seen.has(n.path) && (seen.add(n.path), true))));
        } catch (error) {
            this.#say(`retry failed: ${said(error)}`);
        } finally {
            this.#retrying = false;
        }
    }
}

/** The commits a claim attests: `work.commits`, each a sha or an object naming one. Anything that is not a hex sha is dropped. */
function commitsOf(claim: unknown): string[] {
    const commits = (claim as { work?: { commits?: unknown } } | null)?.work?.commits;
    if (!Array.isArray(commits)) return [];
    const shas = commits.map((c) => (typeof c === 'string' ? c : (c as { sha?: unknown; commit?: unknown; id?: unknown } | null)?.sha ?? (c as { commit?: unknown } | null)?.commit ?? (c as { id?: unknown } | null)?.id));
    return [...new Set(shas.filter((s): s is string => typeof s === 'string' && SHA.test(s)))];
}

/** What the person is asked to sign, in words: the task, the How Done? score, the commits. */
function describe(claim: unknown): string {
    const c = claim as { request?: { task?: unknown; story?: unknown }; score?: { value?: unknown; checkpoint?: unknown } } | null;
    const task = c?.request?.task ?? c?.request?.story ?? '?';
    const score = c?.score ? `${String(c.score.value)} (${String(c.score.checkpoint)})` : 'unscored';
    const commits = commitsOf(claim).map((s) => s.slice(0, 7)).join(', ');
    return `Tynn task ${String(task)}, How Done? ${score}${commits ? `, commits ${commits}` : ''}`;
}
