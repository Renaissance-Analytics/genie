import type { MailSource, MailSummary } from '../core/mail-routing.js';

/**
 * GENIE'S SHARED MAILPIT, READ THROUGH ITS API ON LOOPBACK (Genie Mail G6, Tynn #492). Only what the `mail` tool needs:
 * pages of message summaries (newest first, Mailpit's own order), one message, its headers, and deleting messages.
 * Which messages are whose is NOT decided here: the tool routes each summary (core/mail-routing.ts) before it asks for
 * a message, so another workspace's message is never fetched, and never marked read by being fetched.
 */
interface Address { readonly Address: string; readonly Name?: string }

/** A message as Mailpit lists it (GET /api/v1/messages, /api/v1/search). */
export interface MailpitSummary extends MailSummary {
    readonly MessageID: string;
    readonly Read: boolean;
    readonly ReplyTo: readonly Address[];
    readonly Subject: string;
    readonly Created: string;
    readonly Size: number;
    /** How many attachments. */
    readonly Attachments: number;
    readonly Snippet: string;
}

export interface MailpitPart {
    readonly PartID: string;
    readonly FileName: string;
    readonly ContentType: string;
    readonly ContentID: string;
    readonly Size: number;
}

/** One message, whole (GET /api/v1/message/{ID}). */
export interface MailpitMessage {
    readonly ID: string;
    readonly MessageID: string;
    readonly From?: Address | null | undefined;
    readonly To: readonly Address[];
    readonly Cc: readonly Address[];
    readonly Bcc: readonly Address[];
    readonly ReplyTo: readonly Address[];
    readonly ReturnPath: string;
    readonly Subject: string;
    readonly Date: string;
    readonly Tags?: readonly string[] | null | undefined;
    readonly Size: number;
    readonly Text: string;
    readonly HTML: string;
    readonly Inline: readonly MailpitPart[];
    readonly Attachments: readonly MailpitPart[];
}

export interface MailpitReader {
    /** Where these messages were read: Genie's shared Mailpit, whose send API is closed (G2), so a Username is SMTP's. */
    readonly source: MailSource;
    /** A page of summaries, newest first; with `search`, Mailpit's own search. */
    page(options: { start: number; limit: number; search?: string }): Promise<{ messages: MailpitSummary[]; total: number }>;
    message(id: string): Promise<MailpitMessage>;
    headers(id: string): Promise<Record<string, string[]>>;
    remove(ids: readonly string[]): Promise<void>;
}

/** The shared Mailpit's source: its send API has Genie's own credential, so its Usernames are authenticated SMTP users. */
export const SHARED_MAIL_SOURCE: MailSource = { id: 'shared', sendApiClosed: true };

export function mailpitReader(baseUrl: string, fetchImpl: typeof fetch = fetch): MailpitReader {
    const base = baseUrl.replace(/\/+$/, '');
    const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
        const res = await fetchImpl(`${base}${path}`, init);
        if (!res.ok) throw new Error(`Genie's Mailpit answered ${res.status} for ${path.split('?')[0]}`);
        return (await res.json()) as T;
    };
    const id = (value: string) => encodeURIComponent(value);
    return {
        source: SHARED_MAIL_SOURCE,
        page: async ({ start, limit, search }) => {
            const query = new URLSearchParams({ start: String(start), limit: String(limit), ...(search ? { query: search } : {}) });
            const r = await json<{ messages?: MailpitSummary[] | null; total?: number; messages_count?: number }>(`/api/v1/${search ? 'search' : 'messages'}?${query}`);
            return { messages: r.messages ?? [], total: r.messages_count ?? r.total ?? 0 };
        },
        message: (messageId) => json<MailpitMessage>(`/api/v1/message/${id(messageId)}`),
        headers: (messageId) => json<Record<string, string[]>>(`/api/v1/message/${id(messageId)}/headers`),
        remove: async (ids) => {
            const res = await fetchImpl(`${base}/api/v1/messages`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ IDs: ids }) });
            if (!res.ok) throw new Error(`Genie's Mailpit answered ${res.status} deleting messages`);
        },
    };
}
