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

    /** Bring every attached workspace's default inbox and credentials up, then let Mailpit read the book, in that order. */
    sync(): Promise<void> {
        const run = this.#syncing.then(() => this.#sync());
        this.#syncing = run.catch(() => undefined);
        return run;
    }

    async #sync(): Promise<void> {
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
        if (changed.length === 0) return;
        // 2: the env, before Mailpit reads the book.
        this.#ports.envChanged(changed);
        // 3: Mailpit reads the book: wired now (it reads it as it starts), or restarted to read the new inboxes.
        if (!this.#ports.wired()) await this.#ports.wire();
        else await this.#ports.restart();
    }
}
