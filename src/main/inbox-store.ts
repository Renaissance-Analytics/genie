import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ATTACHMENT_LIMITS, attachmentRefusal, isExecutableName, type Participant } from '../core/inbox.js';
import { sequenceV1Mail, type V1InboxPlan } from '../core/v1-inbox.js';
import { runtimeDir } from './paths.js';
import { readJson, writeJsonAtomic } from './store.js';

/**
 * AGENTINBOX — the durable half (§6.4).
 *
 * One JSON file under the runtime directory holds every message's envelope and every
 * participant's read cursor, written atomically the way `store.ts` writes agent records; the
 * attachment BYTES live beside it, content-addressed, so a file sent twice is stored once and a
 * recipient reads it after the sender's copy is gone.
 *
 * ## Read semantics, which are the whole point
 *
 * - A participant's cursor is the `seq` of the last message they ACKNOWLEDGED. `receive` with
 *   the default `acknowledge: true` advances it to the last message of the page it returned —
 *   and that is the only operation that does. Nothing marks mail read on your behalf: not a
 *   send, not a listing, not the Deck. v1 lost messages exactly where a surface "helpfully"
 *   committed a cursor for a reader that never saw the page.
 * - The cursor REWINDS. `receive({ cursor: n })` pages from `n` regardless of the committed
 *   position, and acknowledging that page recommits from there — possibly backwards. That is
 *   the recovery path for mail marked read that did not reach you.
 * - A read receipt is written when a RECIPIENT's acknowledged receive returns the message. The
 *   sender sees `readAt`; `null` means unread, which is a fact, not a dash.
 *
 * ## Long-poll
 *
 * `receive({ wait: true })` with nothing unread parks a waiter; `send` wakes the waiters whose
 * participant the new message is for, and only those. A timeout resolves empty with the cursor
 * untouched. One blocking call replaces a poll loop; the reminder surface in the UI is what
 * nags, never this store.
 */

export interface StoredAttachment {
    readonly id: string;
    readonly name: string;
    readonly size: number;
    readonly sha256: string;
}

export interface InboxMessage {
    /** Monotonic, store-wide. The cursor is a `seq`. */
    readonly seq: number;
    readonly id: string;
    readonly from: Participant;
    readonly to: Participant;
    readonly text: string;
    readonly attachments: readonly StoredAttachment[];
    readonly sentAt: string;
    /** When the recipient's acknowledged receive returned it. `null` = unread. */
    readonly readAt: string | null;
}

interface MailFile {
    messages: InboxMessage[];
    /** participant → seq of the last acknowledged message. */
    cursors: Record<string, number>;
    /** Genie 1's history import (core/v1-inbox.ts), once it ran — `sawV1: false` is a blind boot, provisional. */
    v1Import?: V1InboxImportRecord;
}

export interface V1InboxImportRecord {
    readonly at: string;
    readonly sawV1: boolean;
    readonly imported: number;
    /** Planned v1 messages whose id was already here — left exactly as they were. */
    readonly kept: number;
    /** What was not imported, or not imported whole, with why. Counts and ids — never message text. */
    readonly notes: readonly string[];
}

export type V1InboxImportResult = { imported: number; kept: number; alreadyDone?: true; noV1?: true };

export interface SendInput {
    readonly from: Participant;
    readonly to: Participant;
    readonly text: string;
    /** Absolute paths. Read and copied at send time; the paths themselves are never stored. */
    readonly attachments?: readonly string[];
}

export interface ReceiveInput {
    readonly participant: Participant;
    /** Page from here instead of the committed cursor. Lower than committed = rewind. */
    readonly cursor?: number;
    /** Default true. `false` fetches without committing — the mail stays unread. */
    readonly acknowledge?: boolean;
    readonly limit?: number;
    readonly wait?: boolean;
    readonly timeoutMs?: number;
}

export interface ReceivePage {
    readonly messages: readonly InboxMessage[];
    /** The committed cursor after this call. */
    readonly cursor: number;
}

export interface Receipt {
    readonly message: InboxMessage;
    readonly readAt: string | null;
}

const DEFAULT_WAIT_MS = 4 * 60_000;
const MAX_WAIT_MS = 10 * 60_000;

interface Waiter {
    participant: Participant;
    wake: () => void;
}

export class InboxStore {
    readonly #dir: string;
    #mail: MailFile;
    readonly #waiters = new Set<Waiter>();
    readonly #sendListeners = new Set<(to: Participant) => void>();
    readonly #readListeners = new Set<(reader: Participant) => void>();
    readonly #now: () => string;

    private constructor(dir: string, mail: MailFile, now: () => string) {
        this.#dir = dir;
        this.#mail = mail;
        this.#now = now;
    }

    static async open(userData: string, now: () => string = () => new Date().toISOString()): Promise<InboxStore> {
        const dir = join(runtimeDir(userData), 'inbox');
        const mail = await readJson<MailFile>(join(dir, 'mail.json'), { messages: [], cursors: {} });
        return new InboxStore(dir, mail, now);
    }

    get mailFile(): string {
        return join(this.#dir, 'mail.json');
    }

    get attachmentsDir(): string {
        return join(this.#dir, 'attachments');
    }

    /** A message landed for `to` — the event the reminder wiring keys on, so nothing polls. */
    onSend(listener: (to: Participant) => void): () => void {
        this.#sendListeners.add(listener);
        return () => { this.#sendListeners.delete(listener); };
    }

    /** A receive acknowledged mail — `reader` read it. What a sender's read receipts change on (nothing polls). */
    onRead(listener: (reader: Participant) => void): () => void {
        this.#readListeners.add(listener);
        return () => { this.#readListeners.delete(listener); };
    }

    /** Mail to or from `participant`, oldest first, the newest `limit` — a conversation's raw material. */
    involving(participant: Participant, limit = 200): InboxMessage[] {
        return this.#mail.messages.filter((m) => m.from === participant || m.to === participant).slice(-Math.max(limit, 1));
    }

    async send(input: SendInput): Promise<InboxMessage> {
        // Everything that can refuse happens BEFORE anything is written: one bad path and the
        // message is not delivered, no blob lands, and the caller is told which path.
        const attachments = await this.#stageAttachments(input.attachments ?? []);
        const seq = (this.#mail.messages.at(-1)?.seq ?? 0) + 1;
        const message: InboxMessage = {
            seq,
            id: `msg_${randomUUID()}`,
            from: input.from,
            to: input.to,
            text: input.text,
            attachments,
            sentAt: this.#now(),
            readAt: null,
        };
        this.#mail.messages.push(message);
        await this.#flush();

        for (const w of [...this.#waiters]) {
            if (w.participant === input.to) w.wake();
        }
        for (const l of this.#sendListeners) l(input.to);
        return message;
    }

    async receive(input: ReceiveInput): Promise<ReceivePage> {
        const participant = input.participant;
        const from = input.cursor ?? this.#cursorOf(participant);
        let page = this.#after(participant, from, input.limit);

        if (page.length === 0 && input.wait) {
            await this.#waitFor(participant, Math.min(input.timeoutMs ?? DEFAULT_WAIT_MS, MAX_WAIT_MS));
            page = this.#after(participant, from, input.limit);
        }

        if (page.length > 0 && input.acknowledge !== false) {
            const last = page.at(-1)!.seq;
            const readAt = this.#now();
            this.#mail.cursors[participant] = last;
            this.#mail.messages = this.#mail.messages.map((m) =>
                m.to === participant && m.readAt === null && m.seq > from && m.seq <= last ? { ...m, readAt } : m,
            );
            await this.#flush();
            page = page.map((m) => this.#mail.messages.find((x) => x.seq === m.seq)!);
            for (const l of this.#readListeners) l(participant);
        }

        return { messages: page, cursor: this.#cursorOf(participant) };
    }

    /** Mail for `participant` after their committed cursor. The UI's reminder count. */
    unreadCount(participant: Participant): number {
        return this.unread(participant).length;
    }

    /**
     * The unread mail itself, WITHOUT committing anything — what the Deck's unread-dm source and the
     * chat flyout read. Only the participant's own `receive` marks it read.
     */
    unread(participant: Participant): InboxMessage[] {
        return this.#after(participant, this.#cursorOf(participant));
    }

    /** What `from` sent, newest first, with whether each was read. */
    receipts(from: Participant, limit = 20): Receipt[] {
        return this.#mail.messages
            .filter((m) => m.from === from)
            .slice(-Math.min(Math.max(limit, 1), 100))
            .reverse()
            .map((message) => ({ message, readAt: message.readAt }));
    }

    /**
     * The bytes of an attachment, for a PARTY to its message. The id alone is not access: a
     * participant who was neither sender nor recipient is refused even with a valid id.
     */
    async attachmentBytes(participant: Participant, attachmentId: string): Promise<Buffer> {
        const { attachment } = this.#attachmentFor(participant, attachmentId);
        return readFile(join(this.attachmentsDir, attachment.sha256));
    }

    /** Write an attachment to `dest`. Refuses an executable name and, without `overwrite`, an existing file. */
    async saveAttachment(
        participant: Participant,
        attachmentId: string,
        dest: string,
        options: { overwrite?: boolean } = {},
    ): Promise<string> {
        const { attachment } = this.#attachmentFor(participant, attachmentId);
        if (isExecutableName(basename(dest))) {
            throw new Error(`${basename(dest)} is a natively executable name and is refused at the receiving end`);
        }
        if (!options.overwrite && (await exists(dest))) {
            throw new Error(`${dest} exists; pass overwrite to replace it`);
        }
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(join(this.attachmentsDir, attachment.sha256), dest);
        return dest;
    }

    /** Genie 1's history import, if it ran here. */
    v1Import(): V1InboxImportRecord | null {
        return this.#mail.v1Import ?? null;
    }

    /**
     * Bring Genie 1's AgentInbox history in, ONCE (core/v1-inbox.ts has the rules). Recorded in mail.json itself, so
     * a second boot does nothing; a blind boot (`plan` null) is recorded as provisional and a later boot that sees v1
     * still imports. Mail already here is never renumbered, rewritten or re-read: history takes the seqs below it,
     * and only a participant with no cursor yet gets one. An attachment whose bytes v1 no longer has (or whose bytes
     * do not match their hash) is left off its message, noted. One write: the messages, cursors and record land together.
     */
    async importFromV1(plan: V1InboxPlan | null, blob: (sha256: string) => Buffer | null): Promise<V1InboxImportResult> {
        const prior = this.v1Import();
        if (prior?.sawV1) return { imported: 0, kept: 0, alreadyDone: true };
        if (plan === null) {
            if (prior === null) {
                this.#mail = { ...this.#mail, v1Import: { at: this.#now(), sawV1: false, imported: 0, kept: 0, notes: [] } };
                await this.#flush();
            }
            return { imported: 0, kept: 0, noV1: true };
        }
        const notes = [...plan.notes];
        const stored = new Set<string>();
        let missing = 0;
        const mail: Array<V1InboxPlan['mail'][number]> = [];
        for (const m of plan.mail) {
            const attachments: StoredAttachment[] = [];
            for (const a of m.attachments) {
                if (!stored.has(a.sha256)) {
                    const bytes = blob(a.sha256);
                    if (bytes === null || createHash('sha256').update(bytes).digest('hex') !== a.sha256) { missing++; continue; }
                    await this.#storeBlob(a.sha256, bytes);
                    stored.add(a.sha256);
                }
                attachments.push(a);
            }
            mail.push({ ...m, attachments });
        }
        if (missing) notes.push(`${missing} attachments left off their messages: Genie 1 no longer has their bytes`);
        const seqs = this.#mail.messages.map((m) => m.seq);
        const done = sequenceV1Mail({ mail, notes: [] }, {
            ids: new Set(this.#mail.messages.map((m) => m.id)),
            cursors: this.#mail.cursors,
            lowestSeq: seqs.length ? Math.min(...seqs) : null,
        }, this.#now());
        notes.push(...done.notes);
        const next: MailFile = {
            messages: [...done.messages, ...this.#mail.messages],
            cursors: { ...done.cursors, ...this.#mail.cursors },
            v1Import: { at: this.#now(), sawV1: true, imported: done.messages.length, kept: done.kept, notes },
        };
        // Written first, adopted after: a failed write leaves this process on the mail it had, and the next boot retries.
        await writeJsonAtomic(this.mailFile, next);
        this.#mail = next;
        return { imported: done.messages.length, kept: done.kept };
    }

    #cursorOf(participant: Participant): number {
        return this.#mail.cursors[participant] ?? 0;
    }

    #after(participant: Participant, cursor: number, limit?: number): InboxMessage[] {
        const page = this.#mail.messages.filter((m) => m.to === participant && m.seq > cursor);
        return limit === undefined ? page : page.slice(0, Math.max(limit, 1));
    }

    #waitFor(participant: Participant, timeoutMs: number): Promise<void> {
        return new Promise((resolve) => {
            const waiter: Waiter = {
                participant,
                wake: () => {
                    clearTimeout(timer);
                    this.#waiters.delete(waiter);
                    resolve();
                },
            };
            const timer = setTimeout(waiter.wake, timeoutMs);
            this.#waiters.add(waiter);
        });
    }

    #attachmentFor(participant: Participant, attachmentId: string): { message: InboxMessage; attachment: StoredAttachment } {
        for (const message of this.#mail.messages) {
            const attachment = message.attachments.find((a) => a.id === attachmentId);
            if (!attachment) continue;
            if (message.from !== participant && message.to !== participant) {
                throw new Error(`${participant} is not a party to the message carrying attachment ${attachmentId}`);
            }
            return { message, attachment };
        }
        throw new Error(`no attachment ${attachmentId}`);
    }

    /**
     * Read, check and copy every attachment before the message exists.
     *
     * Sizes are measured off the real files first, so a 25 MB + 1 file is refused before a byte
     * is copied. Then each file is hashed and stored under its hash: identical bytes land once.
     * A path that cannot be read fails the whole send by throwing with that path in the message.
     */
    async #stageAttachments(paths: readonly string[]): Promise<StoredAttachment[]> {
        const sized: Array<{ path: string; name: string; size: number }> = [];
        for (const p of paths) {
            let size: number;
            try {
                size = (await stat(p)).size;
            } catch (error) {
                throw new Error(`attachment ${p} could not be read; nothing was sent (${(error as Error).message})`);
            }
            sized.push({ path: p, name: basename(p), size });
        }
        const refusal = attachmentRefusal(sized);
        if (refusal !== null) throw new Error(refusal);

        const stored: StoredAttachment[] = [];
        for (const f of sized) {
            const bytes = await readFile(f.path);
            if (bytes.length > ATTACHMENT_LIMITS.perFileBytes) throw new Error(`${f.name} grew past 25 MB while being read`);
            const sha256 = createHash('sha256').update(bytes).digest('hex');
            await this.#storeBlob(sha256, bytes);
            stored.push({ id: `att_${randomUUID()}`, name: f.name, size: bytes.length, sha256 });
        }
        return stored;
    }

    async #storeBlob(sha256: string, bytes: Buffer): Promise<void> {
        const target = join(this.attachmentsDir, sha256);
        if (await exists(target)) return;
        await mkdir(this.attachmentsDir, { recursive: true });
        const tmp = `${target}.${randomUUID()}.tmp`;
        await writeFile(tmp, bytes);
        await rename(tmp, target);
    }

    async #flush(): Promise<void> {
        await writeJsonAtomic(this.mailFile, this.#mail);
    }
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}
