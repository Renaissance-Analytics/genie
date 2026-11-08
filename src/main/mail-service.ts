import { slugLabel } from '../core/gen-name.js';
import { DEFAULT_INBOX, type Inbox } from '../core/mail.js';
import type { MailCredentials } from '../core/services.js';
import { v1WorkspaceSlug } from '../core/v1-services.js';
import { MailHost } from './mail-host.js';

/**
 * GENIE MAIL G5 (Tynn story #491; spec .ai/plans/specs/genie-mail.md): EACH WORKSPACE SENDS AS ITS DEFAULT INBOX.
 *
 * A workspace whose env comes from Genie's shared Mailpit gets a default inbox (`app@<workspace>.mail.gen`) the first
 * time it uses it, reused after. Its password goes to the host keychain (for env injection only) and into the
 * workspace's env as MAIL_USERNAME / MAIL_PASSWORD, with MAIL_FROM_ADDRESS at its address (service-registry.ts envFor).
 *
 * THE ORDER, so no app is ever refused (the owner's ruling, 2026-11-08; G3 measured that an empty book makes Mailpit ask
 * no one for credentials, and its first inbox makes every unauthenticated sender get 530):
 *   1. every workspace using the shared Mailpit has its default inbox, its password kept;
 *   2. its env is told it changed, so its running sites restart with the credentials (site-manager serviceEnvChanged);
 *   3. only then does Mailpit read the book: the live one made before G5 is wired to it (recreated with the auth
 *      directory, service-registry.ts wireMail), or, once wired, restarted to read the new inboxes (G1's finding 7).
 * The inbox book never restarts Mailpit itself here: this service decides when, after the env.
 */
export interface MailServicePorts {
    readonly storeFile: string;
    readonly authDir: string;
    readonly hash: (password: string) => Promise<string>;
    readonly randomPassword?: () => string;
    readonly now?: () => number;
    /** The host keychain, for the default inboxes' passwords only. `set` answers whether it was kept. */
    readonly secrets: { get(name: `mail/inbox/${string}`): Promise<string | null>; set(name: `mail/inbox/${string}`, value: string): Promise<boolean> };
    /** The workspaces whose env comes from Genie's shared Mailpit. */
    readonly attachedWorkspaces: () => readonly string[];
    /** Does the live shared Mailpit read the book yet? */
    readonly wired: () => boolean;
    /** Point the live shared Mailpit at the book (it reads it as it starts). Called once, after every credential exists. */
    readonly wire: () => Promise<void>;
    /** Restart the shared Mailpit so it reads the book again. */
    readonly restart: () => Promise<void>;
    /** These workspaces' env changed: their running sites restart with it. */
    readonly envChanged: (workspaceIds: readonly string[]) => void;
    /**
     * Restart these workspaces' RUNNING background processes so they read the credentials (a process reads its env as it
     * starts). `ok: false` names what could not restart: Mailpit then waits. Absent = no process book here.
     */
    readonly restartProcesses?: (workspaceIds: readonly string[]) => Promise<{ ok: true } | { ok: false; reason: string }>;
    /** Where a held-back wiring is said (the host's log). */
    readonly say?: (line: string) => void;
}

/** A workspace's mail name, the `<workspace>` of `app@<workspace>.mail.gen`: one DNS label from its derived slug. */
export function mailSlugOf(workspaceId: string): string {
    return slugLabel(v1WorkspaceSlug(workspaceId)) || 'workspace';
}

const secretOf = (inbox: Inbox): `mail/inbox/${string}` => `mail/inbox/${inbox.id}`;

export class MailService {
    readonly #ports: MailServicePorts;
    readonly #book: MailHost;
    readonly #credentials = new Map<string, MailCredentials>();
    /** Workspaces whose credentials are in their env but whose running processes have not restarted with them yet. */
    readonly #pending = new Set<string>();
    #waiting: string | null = null;
    #syncing: Promise<void> = Promise.resolve();

    private constructor(ports: MailServicePorts, book: MailHost) {
        this.#ports = ports;
        this.#book = book;
    }

    static async open(ports: MailServicePorts): Promise<MailService> {
        const book = await MailHost.open({
            storeFile: ports.storeFile,
            authDir: ports.authDir,
            hash: ports.hash,
            ...(ports.randomPassword ? { randomPassword: ports.randomPassword } : {}),
            ...(ports.now ? { now: ports.now } : {}),
            // Never by the book: sync restarts Mailpit itself, after the env has the credentials.
            restartMailpit: async () => {},
        });
        return new MailService(ports, book);
    }

    /** A workspace's default inbox credentials for its env, or null while it has none. */
    credentialsFor(workspaceId: string): MailCredentials | null {
        return this.#credentials.get(workspaceId) ?? null;
    }

    /** Why Mailpit is not reading the book yet (a process that could not restart), or null. */
    waiting(): string | null {
        return this.#waiting;
    }

    /** Bring every attached workspace's default inbox and credentials up, then let Mailpit read the book, in that order. */
    sync(): Promise<void> {
        return this.#serial(() => this.#sync());
    }

    /** A workspace's inboxes (Genie Mail G6, the `mail` tool): never a password or a hash. */
    inboxes(workspaceId: string): Inbox[] {
        return this.#book.list(workspaceId);
    }

    /**
     * A new inbox for the `mail` tool (G6), its password answered once; then Mailpit restarted to read it (G1's finding
     * 7). Only for a workspace whose mail is Genie Mail; another is refused with nothing written.
     */
    createInbox(workspaceId: string, name: string): Promise<{ inbox: Inbox; password: string }> {
        return this.#serial(async () => {
            if (!this.#ports.attachedWorkspaces().includes(workspaceId)) {
                throw new Error("this workspace's mail is not Genie Mail: it has no shared Mailpit. Add one with `services add` (engine mailpit). Nothing was created");
            }
            const made = await this.#book.create({ workspaceId, workspaceSlug: mailSlugOf(workspaceId), name }, { restart: false });
            await this.#sync(true);
            return made;
        });
    }

    /**
     * A new password for one of the workspace's inboxes (G6), answered once. Its DEFAULT inbox is its sites' and
     * processes' identity (G5), so that one goes the G5 way: the keychain, the env, its running processes, then Mailpit.
     */
    rotateInbox(workspaceId: string, inboxId: string): Promise<{ inbox: Inbox; password: string }> {
        return this.#serial(async () => {
            const inbox = this.#own(workspaceId, inboxId);
            const rotated = await this.#book.rotate(inbox.id);
            if (inbox.name === DEFAULT_INBOX) {
                if (await this.#ports.secrets.set(secretOf(rotated.inbox), rotated.password)) {
                    this.#credentials.set(workspaceId, { username: rotated.inbox.smtpUser, password: rotated.password, from: rotated.inbox.address });
                    this.#ports.envChanged([workspaceId]);
                    this.#pending.add(workspaceId);
                } else {
                    // Not kept: the env cannot be restored to it after a restart, so the env is not given it. Said.
                    this.#credentials.delete(workspaceId);
                    this.#ports.say?.(`Genie Mail: the keychain did not keep ${rotated.inbox.address}'s new password; its workspace's apps get it again on the next sync`);
                }
            }
            await this.#sync(true);
            return rotated;
        });
    }

    /** Delete one of the workspace's inboxes (G6); never its default inbox, which its sites and processes send as. */
    removeInbox(workspaceId: string, inboxId: string): Promise<void> {
        return this.#serial(async () => {
            const inbox = this.#own(workspaceId, inboxId);
            if (inbox.name === DEFAULT_INBOX) throw new Error(`${inbox.address} is this workspace's default inbox: its sites and processes send as it, so it is not deleted`);
            await this.#book.remove(inbox.id);
            await this.#sync(true);
        });
    }

    #own(workspaceId: string, inboxId: string): Inbox {
        const inbox = this.#book.list(workspaceId).find((i) => i.id === inboxId);
        if (!inbox) throw new Error(`${inboxId} is not one of this workspace's inboxes; nothing was changed`);
        return inbox;
    }

    #serial<T>(work: () => Promise<T>): Promise<T> {
        const run = this.#syncing.then(work);
        this.#syncing = run.then(() => undefined, () => undefined);
        return run;
    }

    /** `bookChanged`: the book was just changed (G6), so Mailpit reads it again even if no env changed. */
    async #sync(bookChanged = false): Promise<void> {
        const changed: string[] = [];
        for (const workspaceId of this.#ports.attachedWorkspaces()) {
            if (this.#credentials.has(workspaceId)) continue;
            const existing = this.#book.list(workspaceId).find((i) => i.name === DEFAULT_INBOX);
            if (existing) {
                const kept = await this.#ports.secrets.get(secretOf(existing));
                if (kept !== null) {
                    // Known from before: its env already had these; nothing changed, nothing to restart.
                    this.#credentials.set(workspaceId, { username: existing.smtpUser, password: kept, from: existing.address });
                    continue;
                }
                // The keychain lost it: not guessed. A new password, kept, and the env told.
                const rotated = await this.#book.rotate(existing.id);
                if (!(await this.#ports.secrets.set(secretOf(rotated.inbox), rotated.password))) continue;
                this.#credentials.set(workspaceId, { username: rotated.inbox.smtpUser, password: rotated.password, from: rotated.inbox.address });
                changed.push(workspaceId);
                continue;
            }
            const created = await this.#book.create({ workspaceId, workspaceSlug: mailSlugOf(workspaceId), name: DEFAULT_INBOX }, { restart: false });
            // A password the keychain would not keep is never put in an env it could not be restored to after a restart.
            if (!(await this.#ports.secrets.set(secretOf(created.inbox), created.password))) continue;
            this.#credentials.set(workspaceId, { username: created.inbox.smtpUser, password: created.password, from: created.inbox.address });
            changed.push(workspaceId);
        }
        // 2: the env (its running sites restart with it), before Mailpit reads the book.
        if (changed.length > 0) this.#ports.envChanged(changed);
        for (const workspaceId of changed) this.#pending.add(workspaceId);
        if (this.#pending.size === 0 && !bookChanged) return;
        // 2b: the running background processes too: one left on the old env would send with no credentials and get 530.
        const processes = this.#pending.size > 0 && this.#ports.restartProcesses ? await this.#ports.restartProcesses([...this.#pending]) : { ok: true as const };
        if (!processes.ok) {
            // Mailpit waits: reading the book now would refuse that process. Said, and tried again on the next sync.
            this.#waiting = processes.reason;
            this.#ports.say?.(`Genie Mail: Mailpit is not reading the inbox book yet, because a running process could not restart with its workspace's mail credentials: ${processes.reason}`);
            return;
        }
        this.#pending.clear();
        this.#waiting = null;
        // 3: Mailpit reads the book: wired now (it reads it as it starts), or restarted to read the new inboxes.
        if (!this.#ports.wired()) await this.#ports.wire();
        else await this.#ports.restart();
    }
}
