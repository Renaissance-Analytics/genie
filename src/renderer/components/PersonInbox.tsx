import type { PersonItem } from '../../core/person-inbox.js';

/**
 * THE PERSON'S INBOX (Tynn #742): only what is addressed to the person, one click from the rail. RED stub.
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

export function PersonInboxView(_p: PersonInboxViewProps) {
    return null;
}

export interface PersonInboxProps {
    open: boolean;
    items: readonly PersonItem[];
    onMarkRead: (messageId: string) => void;
    onMarkAllRead: () => void;
    onReply: (threadKey: string) => void;
    onClose: () => void;
}

export function PersonInbox(_p: PersonInboxProps) {
    return null;
}
