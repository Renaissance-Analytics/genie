import type { JsonObject, McpToolResult } from '@particle-academy/prism-mcp';
import { builtinToolDefinition, declareBuiltinTool, type BuiltinTool } from './builtin-tool.js';
import { DEFAULT_INBOX, type Inbox } from '../core/mail.js';
import { routeMessage } from '../core/mail-routing.js';
import { callerFrom } from './mcp-callers.js';
import { MIRRORED_TERMINAL_ID, type Caller, type Registration } from './mcp-tools.js';
import { MailpitEvents, type MailEventsSource, type SocketFactory } from './mailpit-events.js';
import { mailpitReader, type MailpitReader, type MailpitSummary } from './mailpit-reader.js';
import type { MailService } from './mail-service.js';

/**
 * GENIE MAIL G6: THE `mail` MCP TOOL (Tynn story #492; spec .ai/plans/specs/genie-mail.md). The owner, 2026-11-05: "Every
 * workspace uses a genie mcp to create inboxes for sending and receiving." An agent creates its workspace's inboxes, gets
 * each one's SMTP credentials once, and lists, reads and deletes their mail; the person sees every workspace's at
 * mail.gen (G10 on), an agent only its own.
 *
 * It is the HOST's (HOST_NATIVE_TOOLS): the inbox book, the shared Mailpit and its API live in genie-host, so the tool
 * answers with no window open.
 *
 * What an agent may touch is decided HERE, before anything is called:
 * - Its OWN workspace's inboxes, looked up by name or id among THOSE; another workspace's is "not one of this
 *   workspace's inboxes", by name, with nothing done.
 * - A message is the caller's when G4's routing (core/mail-routing.ts) puts it in one of the caller's inboxes: addressed
 *   to it (Received) or sent with its SMTP user (Sent). Tags never route. This is decided on the message's SUMMARY, so
 *   another workspace's message is never fetched, and never marked read by being fetched; an id that is no message at
 *   all is answered with the same words, so nothing tells whose a message is.
 * - The default inbox (`app`) is the workspace's sites' and processes' identity (G5): it is never deleted, and rotating
 *   it goes the G5 way (mail-service.ts).
 */

/** What the tool acts on. The host composes it from the mail service, the registry's env and the shared Mailpit's API. */
export interface MailPort {
    inboxes(workspaceId: string): readonly Inbox[];
    create(workspaceId: string, name: string): Promise<{ inbox: Inbox; password: string }>;
    rotate(workspaceId: string, inboxId: string): Promise<{ inbox: Inbox; password: string }>;
    remove(workspaceId: string, inboxId: string): Promise<void>;
    /** The SMTP host and port the workspace's env carries; null when its mail is not Genie Mail. */
    smtp(workspaceId: string): { host: string; port: number } | null;
    /** The shared Mailpit's API, or null when there is none to read. */
    reader(): MailpitReader | null;
    /** Why Mailpit is not reading the book yet (mail-service.ts `waiting`), or null. */
    waiting?(): string | null;
    /** The host's subscription to the shared Mailpit's websocket (G7 `wait`), or null when there is none to read. */
    events?(): MailEventsSource | null;
}

export interface MailToolsDeps {
    readonly resolveCaller: (terminalId: string) => Caller | null;
    /** `null` where this Genie has no Genie Mail (doctor mode), and every action says so. */
    readonly mail: MailPort | null;
}

/** The port as the host composes it: the mail service's book, the workspace's env for SMTP, the shared Mailpit's API. */
export function mailToolPort(input: {
    service: Pick<MailService, 'inboxes' | 'createInbox' | 'rotateInbox' | 'removeInbox' | 'waiting'>;
    envFor: (workspaceId: string) => Readonly<Record<string, string>>;
    apiUrl: () => string | null;
    /** Tests: how a websocket is opened. Absent = the runtime's own WebSocket. */
    connect?: SocketFactory;
}): MailPort {
    // ONE subscription for every wait: one socket while anyone waits, none otherwise.
    const events = new MailpitEvents({ url: input.apiUrl, ...(input.connect ? { connect: input.connect } : {}) });
    return {
        inboxes: (ws) => input.service.inboxes(ws),
        create: (ws, name) => input.service.createInbox(ws, name),
        rotate: (ws, id) => input.service.rotateInbox(ws, id),
        remove: (ws, id) => input.service.removeInbox(ws, id),
        smtp: (ws) => {
            const env = input.envFor(ws);
            const port = Number(env.MAIL_PORT);
            return env.MAIL_HOST && Number.isInteger(port) && port > 0 ? { host: env.MAIL_HOST, port } : null;
        },
        reader: () => {
            const url = input.apiUrl();
            return url ? mailpitReader(url) : null;
        },
        waiting: () => input.service.waiting(),
        events: () => (input.apiUrl() ? events : null),
    };
}

const ok = (payload: unknown): McpToolResult => ({ text: JSON.stringify(payload), isError: false });
const err = (message: string): McpToolResult => ({ text: JSON.stringify({ ok: false, error: message }), isError: true });
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

const ACTIONS = 'create, list, messages, read, delete, rotate, wait';
const DEFAULT_WAIT_SECONDS = 60;
const MAX_WAIT_SECONDS = 300;
const NOT_HERE = 'this Genie has no Genie Mail (doctor mode runs none); nothing was done';
const NO_MAIL = 'this workspace has no Genie Mail: its mail is not the shared Mailpit. Add one with `services add` (engine mailpit), then call mail again. Nothing was done';
const NO_MAILPIT = "Genie's shared Mailpit is not there to read (`services list` shows it); nothing was read";
const PAGE = 200;
/** How far back a lookup reads: past every inbox's cap (500 each, decision 5), never the whole store unbounded. */
const SCAN_LIMIT = 20_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const ONCE = 'The password is shown once: Genie keeps only its hash. `rotate` gives a new one.';

const notMine = (id: string) => `${id} is not in this workspace's inboxes; nothing was done`;
const iso = (value: string) => { const t = Date.parse(value); return Number.isNaN(t) ? value : new Date(t).toISOString(); };
const addresses = (list: ReadonlyArray<{ Address: string }> | null | undefined) => (list ?? []).map((a) => a.Address);

/** A message as `messages` and `wait` answer it: metadata only, never its body. */
function summaryView(s: MailpitSummary, inboxes: readonly string[]): Record<string, unknown> {
    return {
        id: s.ID, inboxes, from: s.From?.Address ?? null, to: addresses(s.To), cc: addresses(s.Cc), subject: s.Subject,
        date: iso(s.Created), size: s.Size, read: s.Read, attachments: s.Attachments, snippet: s.Snippet,
    };
}

function inboxView(i: Inbox): Record<string, unknown> {
    return { id: i.id, name: i.name, address: i.address, default: i.name === DEFAULT_INBOX, createdAt: new Date(i.createdAt).toISOString() };
}

/** Summaries newest first, page by page, as far back as SCAN_LIMIT. */
async function* summaries(reader: MailpitReader, search?: string): AsyncGenerator<MailpitSummary> {
    for (let start = 0; start < SCAN_LIMIT; start += PAGE) {
        const page = await reader.page({ start, limit: PAGE, ...(search ? { search } : {}) });
        yield* page.messages;
        if (page.messages.length < PAGE) return;
    }
}

export function mailTools(deps: MailToolsDeps): Registration[] {
    const tool: Registration = {
        definition: builtinToolDefinition(MAIL_TOOL),
        handler: async (args: JsonObject, context) => {
            const caller = callerFrom(args, context.headers, deps.resolveCaller);
            if (typeof caller === 'string') return err(caller);
            const port = deps.mail;
            if (!port) return err(NOT_HERE);
            const action = str(args.action) ?? '';
            const ws = caller.workspaceId;
            const mine = () => port.inboxes(ws).filter((i) => i.workspaceId === ws);
            const inboxOf = (key: string | undefined): Inbox | string => {
                if (!key) return `${action} needs \`inbox\`; \`mail list\` shows them`;
                const found = mine().find((i) => i.id === key || i.name === key || i.address === key);
                return found ?? `${key} is not one of this workspace's inboxes; \`mail list\` shows them. Nothing was done`;
            };
            /** The inboxes (names) of the caller's that a message is routed to, received or sent. */
            const routedTo = (m: Parameters<typeof routeMessage>[0], within: readonly Inbox[], reader: MailpitReader): string[] => {
                const route = routeMessage(m, within, reader.source);
                const ids = new Set([...route.received, ...route.sent]);
                return within.filter((i) => ids.has(i.id)).map((i) => i.name);
            };
            /** The caller's message by id, decided on its summary; a string when it is not the caller's (or is nothing). */
            const ownMessage = async (reader: MailpitReader, id: string | undefined): Promise<{ summary: MailpitSummary; inboxes: string[] } | string> => {
                if (!id) return `${action} needs \`id\` (a message's, from \`mail messages\`)`;
                const own = mine();
                for await (const s of summaries(reader)) {
                    if (s.ID !== id) continue;
                    const inboxes = routedTo(s, own, reader);
                    return inboxes.length > 0 ? { summary: s, inboxes } : notMine(id);
                }
                return notMine(id);
            };
            const credentials = (made: { inbox: Inbox; password: string }, smtp: { host: string; port: number }) => ({
                inbox: inboxView(made.inbox),
                smtp: { host: smtp.host, port: smtp.port, user: made.inbox.smtpUser, password: made.password },
            });
            const pendingNote = () => {
                const why = port.waiting?.() ?? null;
                return why ? { pending: `Mailpit reads this once the workspace's running processes have restarted: ${why}` } : {};
            };
            try {
                switch (action) {
                    case 'create': {
                        const name = str(args.name);
                        if (!name) return err('create needs `name` (lower-case letters, digits and hyphens: signup). Nothing was done');
                        if (!port.smtp(ws)) return err(NO_MAIL);
                        const made = await port.create(ws, name);
                        // Read after the change: the env is what the workspace has now that Mailpit has restarted.
                        const smtp = port.smtp(ws);
                        if (!smtp) return err(`${made.inbox.address} was created, but this workspace's mail env is gone; \`mail list\` shows it`);
                        return ok({ ok: true, ...credentials(made, smtp), note: ONCE, ...pendingNote() });
                    }
                    case 'list':
                        return ok({ ok: true, inboxes: mine().map(inboxView) });
                    case 'messages': {
                        const reader = port.reader();
                        if (!reader) return err(NO_MAILPIT);
                        let within = mine();
                        if (args.inbox !== undefined) {
                            const one = inboxOf(str(args.inbox));
                            if (typeof one === 'string') return err(one);
                            within = [one];
                        }
                        if (args.limit !== undefined && (typeof args.limit !== 'number' || !Number.isFinite(args.limit) || args.limit < 1)) return err('`limit` is a positive number');
                        const limit = Math.min(MAX_LIMIT, typeof args.limit === 'number' ? Math.floor(args.limit) : DEFAULT_LIMIT);
                        const unread = args.unread === true;
                        const found: Array<Record<string, unknown>> = [];
                        if (within.length > 0) {
                            for await (const s of summaries(reader, str(args.search))) {
                                if (unread && s.Read) continue;
                                const inboxes = routedTo(s, within, reader);
                                if (inboxes.length === 0) continue;
                                found.push(summaryView(s, inboxes));
                                if (found.length >= limit) break;
                            }
                        }
                        return ok({ ok: true, messages: found });
                    }
                    case 'read': {
                        const reader = port.reader();
                        if (!reader) return err(NO_MAILPIT);
                        const own = await ownMessage(reader, str(args.id));
                        if (typeof own === 'string') return err(own);
                        const [m, headers] = await Promise.all([reader.message(own.summary.ID), reader.headers(own.summary.ID)]);
                        return ok({
                            ok: true,
                            message: {
                                id: m.ID, inboxes: own.inboxes, from: m.From?.Address ?? null, to: addresses(m.To), cc: addresses(m.Cc), bcc: addresses(m.Bcc),
                                replyTo: addresses(m.ReplyTo), returnPath: m.ReturnPath, subject: m.Subject, date: iso(m.Date), size: m.Size,
                                text: m.Text, html: m.HTML, headers,
                                attachments: (m.Attachments ?? []).map((a) => ({ partId: a.PartID, fileName: a.FileName, contentType: a.ContentType, size: a.Size })),
                            },
                        });
                    }
                    case 'delete': {
                        const id = str(args.id);
                        const inboxKey = str(args.inbox);
                        if ((id === undefined) === (inboxKey === undefined)) return err('delete takes either `id` (a message) or `inbox` (an inbox and its address). Nothing was done');
                        if (id !== undefined) {
                            const reader = port.reader();
                            if (!reader) return err(NO_MAILPIT);
                            const own = await ownMessage(reader, id);
                            if (typeof own === 'string') return err(own);
                            await reader.remove([own.summary.ID]);
                            return ok({ ok: true, deleted: own.summary.ID });
                        }
                        const one = inboxOf(inboxKey);
                        if (typeof one === 'string') return err(one);
                        if (one.name === DEFAULT_INBOX) return err(`${one.address} is this workspace's default inbox: its sites and processes send as it, so it is not deleted. Nothing was done`);
                        await port.remove(ws, one.id);
                        return ok({ ok: true, deletedInbox: one.address });
                    }
                    case 'rotate': {
                        const one = inboxOf(str(args.inbox));
                        if (typeof one === 'string') return err(one);
                        if (!port.smtp(ws)) return err(NO_MAIL);
                        const rotated = await port.rotate(ws, one.id);
                        const smtp = port.smtp(ws);
                        if (!smtp) return err(`${rotated.inbox.address} has a new password, but this workspace's mail env is gone; rotate it again once Mail is back`);
                        return ok({ ok: true, ...credentials(rotated, smtp), note: one.name === DEFAULT_INBOX ? `${ONCE} The workspace's sites and running processes were given it.` : ONCE, ...pendingNote() });
                    }
                    case 'wait': {
                        const reader = port.reader();
                        const events = port.events?.() ?? null;
                        if (!reader || !events) return err(NO_MAILPIT);
                        let within = mine();
                        if (args.inbox !== undefined) {
                            const one = inboxOf(str(args.inbox));
                            if (typeof one === 'string') return err(one);
                            within = [one];
                        }
                        const secs = args.timeoutSeconds;
                        if (secs !== undefined && (typeof secs !== 'number' || !Number.isFinite(secs) || secs < 1 || secs > MAX_WAIT_SECONDS)) {
                            return err(`\`timeoutSeconds\` is 1 to ${MAX_WAIT_SECONDS} (default ${DEFAULT_WAIT_SECONDS})`);
                        }
                        const seconds = typeof secs === 'number' ? secs : DEFAULT_WAIT_SECONDS;
                        const needle = str(args.match)?.toLowerCase();
                        const matches = (s: MailpitSummary) => needle === undefined
                            || [s.Subject, s.Snippet, s.From?.Address, s.From?.Name, ...addresses(s.To), ...addresses(s.Cc)].some((v) => typeof v === 'string' && v.toLowerCase().includes(needle));
                        return await new Promise<McpToolResult>((resolve) => {
                            let done = false;
                            const finish = (result: McpToolResult) => {
                                if (done) return;
                                done = true;
                                clearTimeout(timer);
                                subscription.close();
                                context.signal?.removeEventListener('abort', onAbort);
                                resolve(result);
                            };
                            // An UNREAD message of the caller's that matches: one already read was dealt with before.
                            const consider = (s: MailpitSummary) => {
                                if (done || s.Read || !matches(s)) return;
                                const inboxes = routedTo(s, within, reader);
                                if (inboxes.length > 0) finish(ok({ ok: true, message: summaryView(s, inboxes) }));
                            };
                            // Subscribed FIRST, so nothing taken between the look at what is there and the wait is missed.
                            const subscription = events.subscribe(consider);
                            const timer = setTimeout(() => finish(ok({ ok: true, timedOut: true, note: `timed out after ${seconds} s: nothing matching arrived in this workspace's inboxes` })), seconds * 1000);
                            const onAbort = () => finish(err('the wait was cancelled'));
                            if (context.signal?.aborted) { onAbort(); return; }
                            context.signal?.addEventListener('abort', onAbort);
                            subscription.ready.then(async () => {
                                // What is already there, once (newest first): then only the websocket. Never polled.
                                try {
                                    const page = await reader.page({ start: 0, limit: PAGE });
                                    for (const s of page.messages) consider(s);
                                } catch (error) {
                                    finish(err(`Genie's Mailpit could not be read: ${(error as Error).message}`));
                                }
                            }, (error: Error) => finish(err(`${error.message}; nothing was waited for`)));
                        });
                    }
                    default:
                        return err(`unknown action ${JSON.stringify(action)}; the actions are ${ACTIONS}`);
                }
            } catch (error) {
                return err((error as Error).message);
            }
        },
    };
    return [tool];
}


// ---------------------------------------------------------------- compiled declarations (ADF A2, Tynn #446)
// What this tool IS, as data: the catalog registers it (main/genie-catalog.ts); the factory above binds its handler.
export const MAIL_TOOL: BuiltinTool = declareBuiltinTool(
    'mail',
    'Your workspace’s email inboxes in Genie Mail (Genie’s own local mail catcher: nothing leaves this machine). Use it to test what an app sends — signup, password reset, invoices — never a real mailbox. '
        + 'Each inbox is `<name>@<workspace>.mail.gen` with its own SMTP login; your workspace’s sites and processes already send as its default inbox (`app`). '
        + 'Actions: `create` {name} — a new inbox; answers its address and SMTP host, port, user and password (the password is shown ONCE). '
        + '`list` — this workspace’s inboxes. '
        + '`messages` {inbox?, unread?, search?, limit? (default 20)} — newest first, metadata only (from, to, subject, date, snippet). '
        + '`read` {id} — one message: text, HTML, headers, attachment names and sizes. '
        + '`delete` {id} — a message; `delete` {inbox} — an inbox (not the default one). '
        + '`rotate` {inbox} — a new password, shown once. '
        + '`wait` {inbox?, match?, timeoutSeconds? (default 60, at most 300)} — after making your app send (a signup, a reset), wait for the mail: answers the first UNREAD message of your inboxes whose subject, sender, recipients or snippet contains `match`, as it arrives; with none it answers timedOut (not an error). Then `read` it. '
        + 'You see only this workspace’s inboxes and the messages sent to or from them.',
    {
        type: 'object',
        properties: {
            terminalId: MIRRORED_TERMINAL_ID,
            action: { type: 'string', enum: ['create', 'list', 'messages', 'read', 'delete', 'rotate', 'wait'] },
            name: { type: 'string', description: 'create: the inbox’s name, lower-case letters, digits and hyphens (signup).' },
            inbox: { type: 'string', description: 'messages / delete / rotate: an inbox’s name, address or id, from `list`.' },
            id: { type: 'string', description: 'read / delete: a message’s id, from `messages`.' },
            unread: { type: 'boolean', description: 'messages: unread only.' },
            search: { type: 'string', description: 'messages: Mailpit’s search (words, subject:, from:, to:).' },
            limit: { type: 'number', description: 'messages: how many, newest first (default 20, at most 200).' },
            match: { type: 'string', description: 'wait: text the subject, sender, recipients or snippet contains (case-insensitive); absent = any message.' },
            timeoutSeconds: { type: 'number', description: 'wait: how long to wait, 1 to 300 seconds (default 60).' },
        },
        required: ['action'],
    },
    'Mail'
);
/** This module's tools, in the order its factory returns them. */
export const MAIL_TOOLS: readonly BuiltinTool[] = [MAIL_TOOL];
