/**
 * ONE DRAFT PER CHAT (genie#1261): which chats keep a composer of their own.
 *
 * The chat's composer is react-fancy's `PromptInput`, whose text, paste pills, attachments and caret are its own state
 * with no value or reset API (5.59.0). One instance shared by every chat carried a half-typed message from one agent's
 * chat into the next. So each chat gets its own instance, keyed by its agent, and a chat's instance stays mounted —
 * hidden — while another chat is on screen: back on that chat, its draft is where it was left, because nothing ever
 * dropped it. Sending clears only the instance it was sent from.
 *
 * Genie 1 did the same for the same reason: an agent's draft lived in its TUI's input box, and every terminal panel was
 * one instance keyed by its id, kept mounted-hidden off screen (v0.7.0-beta.342 `renderer/lib/terminal-grid-layout.ts`,
 * `renderer/components/Terminal/Terminal.tsx`).
 *
 * The window's close only hides it (core/tray-resident.ts), so the drafts outlive a close and reopen of the window.
 *
 * PURE: the list is append-only and returned UNCHANGED (same reference) when nothing is added, so the flyout's
 * "keep what I am showing" update settles in one pass and no chat ever changes slot.
 */
export function keepChat(chats: readonly string[], chat: string | null): readonly string[] {
    if (chat === null || chats.includes(chat)) return chats;
    return [...chats, chat];
}
