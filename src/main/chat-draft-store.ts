import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { draftRefs, isDraftRef, isEmptyDraft, parseChatDrafts, pruneChatDrafts, readChatDraft, type ChatDraft, type ChatDrafts } from '../core/chat-drafts.js';
import { runtimeDir } from './paths.js';
import { writeJsonAtomic } from './store.js';
import { BLOB_READ_BYTES, type BlobSource } from '../core/local-blobs.js';

/**
 * EVERY CHAT'S UNSENT DRAFT, ON DISK (genie#1261, the persistence half) — so a half-typed message survives a Genie
 * restart and a renderer reload, not only a switch of chat.
 *
 * Genie 1's model: its part-typed answers lived in MAIN, written to settings "so they survive a window being destroyed
 * AND an app restart", read back, forgotten when answered, pruned to what still exists (v0.7.0-beta.342
 * `main/ask/force-question.ts:1118`, `:1181-1217`; `main/ask/draft-store.ts`). Genie 2's settings file is a typed
 * registry of values, so the drafts have a file of their own beside it: `chat-drafts.json`, written atomically, keyed by
 * agent.
 *
 * ## Attachments are files, not base64
 *
 * A draft carries an attachment's name, type, size and `ref`; the bytes are `chat-drafts/<ref>`, one file each. A
 * screenshot inlined as base64 would be rewritten on every saved keystroke. The ref is a UUID minted HERE, and nothing
 * else is ever read or removed — a ref from the window is never a path.
 *
 * ## Cleanup
 *
 * - **A send** releases exactly the files it sent (`release`), once the message holds their bytes.
 * - **A deleted agent** takes its draft and its files with it (`prune`, when the roster changes: core/chat-drafts.ts rosterPruner).
 * - **At open**, files no draft points at — a chip removed, a quit before the ref was saved — are swept.
 */
/** Larger than this is not kept with a draft: its chip restores, without its bytes. */
export const MAX_DRAFT_FILE_BYTES = 100 * 1024 * 1024;

export class ChatDraftStore {
    readonly file: string;
    readonly filesDir: string;
    #drafts: ChatDrafts;

    private constructor(dir: string, drafts: ChatDrafts) {
        this.file = join(dir, 'chat-drafts.json');
        this.filesDir = join(dir, 'chat-drafts');
        this.#drafts = drafts;
    }

    static async open(home: string): Promise<ChatDraftStore> {
        const dir = runtimeDir(home);
        let raw: unknown = {};
        try {
            raw = JSON.parse(await readFile(join(dir, 'chat-drafts.json'), 'utf8'));
        } catch {
            // Missing (a first run) or unreadable: no drafts. Genie 1's rule — a lost draft must never take the chat down.
        }
        const store = new ChatDraftStore(dir, parseChatDrafts(raw));
        await store.#sweep();
        return store;
    }

    all(): ChatDrafts {
        return this.#drafts;
    }

    /** Record one chat's draft; `null` or an empty draft forgets it. REPLACES: a removed pill or chip must be able to go. */
    async save(agentId: string, raw: unknown): Promise<void> {
        const draft = raw === null ? null : readChatDraft(raw);
        if (raw !== null && draft === null) return; // not a draft this Genie can read: refused, nothing overwritten
        const next: Record<string, ChatDraft> = { ...this.#drafts };
        if (draft === null || isEmptyDraft(draft)) {
            if (!(agentId in next)) return;
            delete next[agentId];
        } else {
            next[agentId] = draft;
        }
        this.#drafts = next;
        await writeJsonAtomic(this.file, next);
    }

    /** Keep an attached file's bytes; the ref is the draft's handle for them. */
    async putFile(bytes: Uint8Array): Promise<string> {
        const ref = randomUUID();
        await mkdir(this.filesDir, { recursive: true });
        await writeFile(join(this.filesDir, ref), bytes);
        return ref;
    }

    /** A kept file's bytes, or `null` — for a ref main never minted, or one already gone. */
    async readFile(ref: unknown): Promise<Uint8Array | null> {
        if (!isDraftRef(ref)) return null;
        try {
            return new Uint8Array(await readFile(join(this.filesDir, ref)));
        } catch {
            return null;
        }
    }

    /** Host-only stable read handle. Hash and bytes stay bounded, including a file not yet saved in a draft. */
    async openFile(ref: unknown, options: { signal?: AbortSignal } = {}): Promise<BlobSource | null> {
        if (!isDraftRef(ref)) throw new Error('a draft file needs a host-minted UUID ref');
        options.signal?.throwIfAborted();
        const path = join(this.filesDir, ref); let file: Awaited<ReturnType<typeof open>> | null = null;
        try {
            const entry = await lstat(path);
            if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('the draft ref is not a regular file in this store');
            file = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
            const stat = await file.stat();
            if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_DRAFT_FILE_BYTES) throw new Error('the draft file is outside its 100 MiB limit');
            const hash = createHash('sha256'), buffer = Buffer.alloc(Math.min(BLOB_READ_BYTES, stat.size));
            for (let at = 0; at < stat.size;) {
                options.signal?.throwIfAborted();
                const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - at), at);
                if (!bytesRead) throw new Error('the draft file changed while its hash was read');
                hash.update(buffer.subarray(0, bytesRead)); at += bytesRead;
            }
            options.signal?.throwIfAborted();
            const held = file; file = null; let closed = false;
            return {
                size: stat.size, sha256: hash.digest('hex'),
                read: async (offset, length) => {
                    if (closed) throw new Error('the kept draft source is closed');
                    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || length > BLOB_READ_BYTES || offset > stat.size || length > stat.size - offset) throw new Error('the draft read is outside its bounded size');
                    const bytes = Buffer.alloc(length);
                    for (let at = 0; at < length;) {
                        const { bytesRead } = await held.read(bytes, at, length - at, offset + at);
                        if (!bytesRead) throw new Error('the draft file ended before its declared size'); at += bytesRead;
                    }
                    if (closed) throw new Error('the kept draft source closed during its read'); return bytes;
                },
                close: async () => { if (closed) return; closed = true; await held.close(); },
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        } finally { await file?.close(); }
    }

    /** Remove these files (a send, once the message holds their bytes). Anything that is not one of ours is ignored. */
    async release(refs: readonly unknown[]): Promise<void> {
        for (const ref of refs) if (isDraftRef(ref)) await rm(join(this.filesDir, ref), { force: true });
    }

    /** Only the agents still here keep a draft: a deleted agent's goes, with its files. Writes nothing when none went. */
    async prune(agentIds: Iterable<string>): Promise<void> {
        const kept = pruneChatDrafts(this.#drafts, agentIds);
        if (kept === this.#drafts) return;
        const gone = Object.keys(this.#drafts).filter((id) => !(id in kept)).flatMap((id) => draftRefs(this.#drafts[id]!));
        this.#drafts = kept;
        await writeJsonAtomic(this.file, kept);
        await this.release(gone);
    }

    /** Every file in the folder no draft points at. Only at open: mid-session, a file may be kept before its ref is saved. */
    async #sweep(): Promise<void> {
        let names: string[];
        try {
            names = await readdir(this.filesDir);
        } catch {
            return;
        }
        const referenced = new Set(Object.values(this.#drafts).flatMap(draftRefs));
        for (const name of names) {
            if (referenced.has(name)) continue;
            // A file that cannot go now (held open, say) goes at a later open; it never stops Genie starting.
            await rm(join(this.filesDir, name), { force: true, recursive: true }).catch((error: unknown) => {
                console.warn(`[genie] chat drafts: could not remove ${name}: ${error instanceof Error ? error.message : String(error)}`);
            });
        }
    }
}
