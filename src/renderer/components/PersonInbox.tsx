import { memo, useState } from 'react';
import { Button, ContentRenderer, Drawer, Icon } from '@particle-academy/react-fancy';
import { genieClipboardWriter } from '../clipboard.js';
import { ago } from '../../core/inbox-threads.js';
import { personLine, personText } from '../../core/person-text.js';
import type { PersonItem } from '../../core/person-inbox.js';
import { APP_KIND_ICON } from './InboxFlyout.js';
import { readAppSender } from '../../core/app-inbox.js';

/**
 * THE PERSON'S INBOX (Tynn #742; LiftPoint onboarding 2026-11-16 — mail for the client was lost among the agents' mail to
 * each other). Only what is addressed to the person (core/person-inbox.ts), one click from the rail, newest first.
 *
 *  - an item opens IN PLACE: its whole text under its own row, which does not move (the row's header is the same open or
 *    closed, and the unread mark keeps its slot when it goes); opening it marks it read;
 *  - Reply is its conversation in the AgentInbox, where the composer, attachments and history already are;
 *  - an app's notice is PLAIN text with its link back into the app, as in the AgentInbox (an app draws no markup).
 *
 * It slides in from the LEFT, beside the rail it was opened from ("on the left-hand side"), over the page, which stays.
 */
export interface PersonInboxViewProps {
    items: readonly PersonItem[];
    /** The item open in place; `null` = none. */
    openId: string | null;
    now: number;
    onOpen: (id: string | null) => void;
    /** Reply: that item's conversation in the AgentInbox. */
    onReply: (threadKey: string) => void;
    onMarkAllRead: () => void;
    onClose: () => void;
}

const Markdown = memo(function Markdown({ text }: { text: string }) {
    return <ContentRenderer clipboardWriter={genieClipboardWriter} value={personText(text)} format="markdown" lineSpacing={1.5} className="text-[13px] text-[var(--fg-2)]" />;
});

const LEVEL_TONE: Readonly<Record<'info' | 'success' | 'failure', string>> = { info: 'text-[var(--fg-3)]', success: 'text-[var(--success)]', failure: 'text-[var(--danger)]' };

function linkHost(link: string): string {
    try { return new URL(link).host; } catch { return link; }
}

function ItemBody({ item, onReply }: { item: PersonItem; onReply: (threadKey: string) => void }) {
    const app = item.kind === 'app';
    return (
        <div data-person-open={item.id} className="flex flex-col gap-2 border-b border-[var(--border-1)] bg-[var(--bg-1)] px-3 py-2">
            {app ? (
                <>
                    {item.subject ? <span className={`text-[13px] font-medium ${item.level ? LEVEL_TONE[item.level] : 'text-[var(--fg-1)]'}`}>{item.subject}</span> : null}
                    <p className="whitespace-pre-wrap break-words text-[13px] text-[var(--fg-2)]">{personLine(item.text)}</p>
                </>
            ) : (
                <Markdown text={item.text} />
            )}
            <span className="flex items-center gap-1.5">
                {item.link ? (
                    <Button data-person-link={item.link} href={item.link} target="_blank" rel="noreferrer" size="xs" variant="ghost" icon="external-link" className="w-fit border border-[var(--border-1)]">
                        {linkHost(item.link)}
                    </Button>
                ) : null}
                {app ? null : (
                    <Button type="button" size="xs" variant="ghost" icon="message-square-reply" data-person-reply={item.threadKey} onClick={() => onReply(item.threadKey)} className="w-fit border border-[var(--border-1)]">
                        Reply
                    </Button>
                )}
            </span>
        </div>
    );
}

export function PersonInboxView(p: PersonInboxViewProps) {
    const unread = p.items.filter((i) => i.unread).length;
    return (
        <div data-person-inbox="" className="flex h-full min-h-0 flex-col">
            <Drawer.Header>
                <div className="flex items-center gap-2">
                    <Icon name="inbox" size="sm" />
                    <span className="text-[14px] font-semibold">Inbox</span>
                    <span className="ml-auto" />
                    {unread > 0 ? <Button type="button" size="sm" variant="ghost" data-person-mark-all="" onClick={p.onMarkAllRead}>Mark all read</Button> : null}
                </div>
            </Drawer.Header>
            {p.items.length === 0 ? (
                <p data-person-empty="" className="px-4 py-6 text-center text-[13px] text-[var(--fg-4)]">Nothing for you yet.</p>
            ) : (
                <ul className="min-h-0 flex-1 overflow-y-auto">
                    {p.items.map((item) => {
                        const open = item.id === p.openId;
                        const appKind = readAppSender(item.from)?.kind;
                        return (
                            <li key={item.id}>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    data-person-item={item.id}
                                    data-unread={item.unread ? 'true' : 'false'}
                                    aria-expanded={open}
                                    onClick={() => p.onOpen(open ? null : item.id)}
                                    className={`w-full flex-col items-stretch justify-start rounded-none border-b border-[var(--border-1)] px-3 py-2 text-left font-normal hover:bg-[var(--bg-2)] ${open ? 'bg-[var(--bg-2)]' : ''}`}
                                    labelClassName="flex w-full flex-col gap-0.5 whitespace-normal"
                                >
                                    <span className="flex items-center gap-2 text-[13px]">
                                        {/* The unread mark keeps its slot when it goes: reading an item moves nothing. */}
                                        <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${item.unread ? 'bg-[var(--warning)]' : 'bg-transparent'}`} />
                                        {appKind ? <Icon name={APP_KIND_ICON[appKind]} size="xs" className="shrink-0 text-[var(--fg-3)]" /> : null}
                                        <span className={`truncate ${item.unread ? 'font-semibold text-[var(--fg-1)]' : 'text-[var(--fg-2)]'}`}>{item.fromName}</span>
                                        <span className="ml-auto shrink-0 font-mono text-[11px] text-[var(--fg-4)]">{Number.isFinite(item.at) ? ago(item.at, p.now) : ''}</span>
                                    </span>
                                    <span className="truncate pl-3.5 text-[12px] text-[var(--fg-3)]">{personLine(item.subject ?? item.preview)}</span>
                                </Button>
                                {open ? <ItemBody item={item} onReply={p.onReply} /> : null}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

export interface PersonInboxProps {
    open: boolean;
    items: readonly PersonItem[];
    onMarkRead: (messageId: string) => void;
    onMarkAllRead: () => void;
    onReply: (threadKey: string) => void;
    onClose: () => void;
    /** The clock the list reads `ago` from; absent = now. */
    now?: number | undefined;
}

/**
 * The drawer. MOUNTED ONLY WHILE OPEN, as the AgentInbox flyout is (Genie loads no react-fancy keyframes, so a Drawer's
 * exit animation never ends and a closed one would stay on screen).
 */
export function PersonInbox(p: PersonInboxProps) {
    const [openId, setOpenId] = useState<string | null>(null);
    if (!p.open) return null;
    const onOpen = (id: string | null): void => {
        setOpenId(id);
        const item = id === null ? undefined : p.items.find((i) => i.id === id);
        if (item?.unread) p.onMarkRead(item.id);
    };
    return (
        <Drawer open onClose={p.onClose} side="left" attach="container" className="w-[min(420px,92%)] bg-[var(--surface)] text-[var(--fg-1)]" data-person-inbox-drawer="">
            <PersonInboxView items={p.items} openId={openId} now={p.now ?? Date.now()} onOpen={onOpen} onReply={p.onReply} onMarkAllRead={p.onMarkAllRead} onClose={p.onClose} />
        </Drawer>
    );
}
