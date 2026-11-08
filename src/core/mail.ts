/**
 * GENIE MAIL'S PURE MODEL (Tynn #383; spec .ai/plans/specs/genie-mail.md, story G3 #489).
 *
 * An INBOX is a workspace's address at `<name>@<workspace>.mail.gen`, with its own SMTP user: the address itself. Its
 * password is generated, written bcrypt-hashed to the shared Mailpit's SMTP auth file (main/mail-host.ts), and returned
 * ONCE; nothing here ever holds it in clear. The file is htpasswd: one `user:hash` line per inbox. Mailpit reads it
 * only at start (G1's finding 7, genie#1712), so the host restarts Mailpit after every change.
 */

/** The auth file's name, in the directory the host mounts into Mailpit (a directory, so a rename-in-place is seen). */
export const MAILPIT_SMTP_AUTH_FILE = 'smtp-auth';
/** Where that directory is inside the Mailpit container. */
export const MAILPIT_AUTH_MOUNT = '/genie-mail';

/** A workspace's default inbox, the one its sites and processes send as (Genie Mail G5): `app@<workspace>.mail.gen`. */
export const DEFAULT_INBOX = 'app';

/** Decision 5 (approved 2026-11-07): per inbox, 500 messages or 200 MB, the oldest pruned first. */
export const MAIL_INBOX_CAPS = { messages: 500, bytes: 200 * 1024 * 1024 } as const;

const INBOX_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const WORKSPACE_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Why a name cannot be an inbox's, in words; null when it can. An address's local part, and an htpasswd user's: no `:` or `@`. */
export function inboxNameProblem(name: string): string | null {
    return INBOX_NAME.test(name) ? null : `${JSON.stringify(name)} is not an inbox name: lower-case letters, digits and hyphens, starting with a letter or digit, at most 32`;
}

/** An inbox's address: `<name>@<workspace>.mail.gen`. The workspace part is a DNS label (its .gen name). */
export function inboxAddress(name: string, workspaceSlug: string): string {
    const problem = inboxNameProblem(name);
    if (problem) throw new Error(problem);
    if (!WORKSPACE_LABEL.test(workspaceSlug)) throw new Error(`${JSON.stringify(workspaceSlug)} is not a workspace's mail name`);
    return `${name}@${workspaceSlug}.mail.gen`;
}

export interface Inbox {
    readonly id: string;
    readonly workspaceId: string;
    readonly name: string;
    readonly address: string;
    /** The SMTP user Mailpit authenticates: the address. */
    readonly smtpUser: string;
    readonly createdAt: number;
}

/** Mailpit's SMTP auth file: one `user:bcrypt-hash` line per inbox, sorted, so the same book is the same bytes. */
export function renderSmtpAuthFile(entries: ReadonlyArray<{ readonly smtpUser: string; readonly hash: string }>): string {
    return [...entries].sort((a, b) => (a.smtpUser < b.smtpUser ? -1 : a.smtpUser > b.smtpUser ? 1 : 0)).map((e) => `${e.smtpUser}:${e.hash}\n`).join('');
}
