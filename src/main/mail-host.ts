import { randomBytes } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inboxAddress, inboxNameProblem, MAILPIT_SMTP_AUTH_FILE, renderSmtpAuthFile, type Inbox } from '../core/mail.js';
import { makePrivate, PRIVATE_FILE, readJson, writeJsonAtomic } from './store.js';

/**
 * THE INBOX BOOK, IN THE HOST (Genie Mail G3, Tynn #489; spec .ai/plans/specs/genie-mail.md).
 *
 * Inboxes are created, listed, rotated and deleted here. An inbox's password is generated, bcrypt-hashed, written to the
 * shared Mailpit's SMTP auth file, and RETURNED ONCE: the book keeps the hash (to write the file again), never the
 * password, and nothing here logs it.
 *
 * G1's finding 7 (genie#1712, measured): Mailpit reads its auth file only at start. So every change writes the file and
 * THEN restarts Mailpit (`restartMailpit`): without that, an old password keeps working and a new one does not. The file
 * lives in its own directory, which the shared Mailpit mounts (core/services.ts `smtpAuthDir`); it is replaced by a
 * rename inside that directory, which a directory mount sees (a single-file mount would keep the old file).
 *
 * One change at a time: a create, rotate or delete waits for the one before it, so the file is never written from two
 * books. A refusal (a bad name, a name the workspace already has, an unknown inbox) writes nothing and restarts nothing.
 */
export interface MailHostPorts {
    /** The book: inboxes and their hashes. A private file under the host's runtime directory. */
    readonly storeFile: string;
    /** The directory holding Mailpit's SMTP auth file, mounted into the shared Mailpit. */
    readonly authDir: string;
    readonly hash: (password: string) => Promise<string>;
    readonly randomPassword?: () => string;
    readonly now?: () => number;
    /** Restart the shared Mailpit so it reads the file again (finding 7). */
    readonly restartMailpit: () => Promise<void>;
    /** Tests: told after each write ('store' | 'auth'), never with what was written. */
    readonly onWrite?: (what: 'store' | 'auth') => void;
}

interface Entry extends Inbox { readonly hash: string }
interface Book { readonly inboxes: readonly Entry[] }

const generatedPassword = () => randomBytes(24).toString('base64url');
const view = ({ hash: _hash, ...inbox }: Entry): Inbox => inbox;

export class MailHost {
    readonly #ports: MailHostPorts;
    #book: Book;
    #queue: Promise<unknown> = Promise.resolve();

    private constructor(ports: MailHostPorts, book: Book) {
        this.#ports = ports;
        this.#book = book;
    }

    /** Open the book and write Mailpit's auth file from it (a lost or stale file is rebuilt; an empty book is an empty file). */
    static async open(ports: MailHostPorts): Promise<MailHost> {
        await makePrivate(ports.storeFile);
        const book = await readJson<Book>(ports.storeFile, { inboxes: [] });
        const host = new MailHost(ports, { inboxes: Array.isArray(book.inboxes) ? book.inboxes : [] });
        await host.#writeAuthFile();
        return host;
    }

    /** The inboxes, a workspace's or every one; never a password or a hash. */
    list(workspaceId?: string): Inbox[] {
        return this.#book.inboxes.filter((i) => workspaceId === undefined || i.workspaceId === workspaceId).map(view);
    }

    /** A new inbox and its password, answered once. */
    /** `restart: false`: the caller restarts Mailpit itself, later (Genie Mail G5 tells the env first). */
    create(input: { workspaceId: string; workspaceSlug: string; name: string }, options: { restart?: boolean } = {}): Promise<{ inbox: Inbox; password: string }> {
        return this.#serial(async () => {
            const problem = inboxNameProblem(input.name);
            if (problem) throw new Error(`${problem}; nothing was created`);
            if (this.#book.inboxes.some((i) => i.workspaceId === input.workspaceId && i.name === input.name)) {
                throw new Error(`this workspace already has an inbox named ${input.name}; nothing was created`);
            }
            const address = inboxAddress(input.name, input.workspaceSlug);
            if (this.#book.inboxes.some((i) => i.smtpUser === address)) throw new Error(`${address} is already an inbox; nothing was created`);
            const password = (this.#ports.randomPassword ?? generatedPassword)();
            const entry: Entry = {
                id: `inbox_${randomBytes(8).toString('hex')}`,
                workspaceId: input.workspaceId,
                name: input.name,
                address,
                smtpUser: address,
                createdAt: (this.#ports.now ?? Date.now)(),
                hash: await this.#ports.hash(password),
            };
            await this.#commit({ inboxes: [...this.#book.inboxes, entry] }, options.restart !== false);
            return { inbox: view(entry), password };
        });
    }

    /** A new password for an inbox, answered once; the old one stops working once Mailpit has restarted. */
    rotate(id: string): Promise<{ inbox: Inbox; password: string }> {
        return this.#serial(async () => {
            const current = this.#find(id);
            const password = (this.#ports.randomPassword ?? generatedPassword)();
            const next: Entry = { ...current, hash: await this.#ports.hash(password) };
            await this.#commit({ inboxes: this.#book.inboxes.map((i) => (i.id === id ? next : i)) });
            return { inbox: view(next), password };
        });
    }

    /** Delete an inbox: its SMTP user stops authenticating once Mailpit has restarted. */
    remove(id: string): Promise<void> {
        return this.#serial(async () => {
            this.#find(id);
            await this.#commit({ inboxes: this.#book.inboxes.filter((i) => i.id !== id) });
        });
    }

    #find(id: string): Entry {
        const entry = this.#book.inboxes.find((i) => i.id === id);
        if (!entry) throw new Error(`no inbox ${id}; nothing was changed`);
        return entry;
    }

    /** The book, then the file, then Mailpit restarted to read it (finding 7). */
    async #commit(book: Book, restart = true): Promise<void> {
        await writeJsonAtomic(this.#ports.storeFile, book, PRIVATE_FILE);
        this.#ports.onWrite?.('store');
        this.#book = book;
        await this.#writeAuthFile();
        if (restart) await this.#ports.restartMailpit();
    }

    async #writeAuthFile(): Promise<void> {
        await mkdir(this.#ports.authDir, { recursive: true });
        const file = join(this.#ports.authDir, MAILPIT_SMTP_AUTH_FILE);
        const temporary = `${file}.${process.pid}.tmp`;
        // Readable by Mailpit's own user inside its container: hashes only, never a password.
        await writeFile(temporary, renderSmtpAuthFile(this.#book.inboxes), { encoding: 'utf8', mode: 0o644 });
        await rename(temporary, file);
        this.#ports.onWrite?.('auth');
    }

    #serial<T>(work: () => Promise<T>): Promise<T> {
        const next = this.#queue.then(work, work);
        this.#queue = next.catch(() => undefined);
        return next;
    }
}
