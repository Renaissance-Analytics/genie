import type { DeckItem } from '../core/deck.js';
import { deckItemsFrom, type DeckSourceInput } from '../core/deck-sources.js';
import { HUMAN } from '../core/inbox.js';
import { folderName } from '../core/workspace-name.js';
import type { AttentionStore } from './attention-store.js';
import type { InboxStore } from './inbox-store.js';

/**
 * THE DECK'S ITEMS (Tynn #551, host split P5d.2): approvals and Genie's own asks grouped under their workspace's name and
 * colour, then the questions, the person's list and unread mail. A finished agent's handoff is not one (Tynn #658). One assembly for the window's snapshot
 * (compose.ts) and genie-host's, which a phone reads with every window closed — the same Deck from either.
 */
export interface DeckAssemblyInput {
    readonly workspaces: readonly { readonly id: string; readonly path: string; readonly asleep?: boolean | undefined }[];
    readonly workspaceName?: ((path: string) => string) | undefined;
    readonly workspaceColor?: ((path: string) => string | null) | undefined;
    readonly approvals: readonly DeckItem[];
    /** Genie's own asks about its front door (Trust its certificate). */
    readonly trust: readonly DeckItem[];
    readonly attention: Pick<AttentionStore, 'pending' | 'allUserItems'>;
    readonly inbox: Pick<InboxStore, 'unread'>;
    readonly agents: Readonly<Record<string, { name: string; workspaceId: string }>>;
    readonly asker?: DeckSourceInput['asker'];
}

export function assembleDeckItems(input: DeckAssemblyInput): DeckItem[] {
    const awake = input.workspaces.filter((workspace) => workspace.asleep !== true);
    const workspaceNames: Record<string, string> = Object.fromEntries(awake.map((w) => [w.id, (input.workspaceName ?? folderName)(w.path)]));
    const workspaceColors: Record<string, string> = Object.fromEntries(awake.flatMap((w) => {
        const color = input.workspaceColor?.(w.path) ?? null;
        return color ? [[w.id, color]] : [];
    }));
    return [
        // An approval is grouped under its workspace on the Deck like a question is, so it carries the same NAME (and colour).
        ...input.approvals.map((i) => {
            const name = i.workspaceId === null ? undefined : workspaceNames[i.workspaceId];
            const color = i.workspaceId === null ? undefined : workspaceColors[i.workspaceId];
            return name === undefined && color === undefined ? i : { ...i, ...(name === undefined ? {} : { workspaceName: name }), ...(color === undefined ? {} : { workspaceColor: color }) };
        }),
        ...input.trust,
        ...deckItemsFrom({
            questions: input.attention.pending(),
            userList: input.attention.allUserItems(),
            unreadDms: input.inbox.unread(HUMAN),
            agents: input.agents,
            workspaceNames,
            workspaceColors,
            ...(input.asker ? { asker: input.asker } : {}),
        }),
    ];
}
