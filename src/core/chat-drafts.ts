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
 * The window's close only hides it (core/tray-resident.ts), so the drafts outlive a close and reopen of the window. A
 * restart or a renderer reload they outlive through the store below: each composer mounts with its chat's kept draft
 * (react-fancy 5.65.0 `defaultDraft`), and every change is written back to main (core/chat-draft-keeper.ts).
 *
 * PURE: the list is append-only and returned UNCHANGED (same reference) when nothing is added, so the flyout's
 * "keep what I am showing" update settles in one pass and no chat ever changes slot.
 */
export function keepChat(chats: readonly string[], chat: string | null): readonly string[] {
    if (chat === null || chats.includes(chat)) return chats;
    return [...chats, chat];
}

/**
 * A CHAT'S DRAFT, KEPT ACROSS A RESTART (genie#1261, the persistence half). react-fancy 5.65.0's `PromptDraft`, described
 * here by shape so the pure core imports no UI package: plain JSON, versioned, the bytes of an attachment NOT in it —
 * only `ref`, the handle Genie's own store minted for them (main/chat-draft-store.ts).
 *
 * Genie 1 kept its part-typed answers the same way: in MAIN, on disk, keyed by what the draft belongs to, read back after
 * a restart (v0.7.0-beta.342 `main/ask/force-question.ts:1118`, `:1181-1217`; `main/ask/draft-store.ts`).
 */
export interface ChatDraftFile {
    id: string;
    name: string;
    type: string;
    bytes: number;
    ref?: string;
}
export type ChatDraftPill = { kind: 'text'; id: string; text: string } | { kind: 'image'; id: string; label: string; file: ChatDraftFile };
export interface ChatDraft {
    v: 1;
    text: string;
    pills: ChatDraftPill[];
    attachments: ChatDraftFile[];
}
export type ChatDrafts = Readonly<Record<string, ChatDraft>>;

/** Nothing worth keeping: no text but whitespace, no pills, no attachments. An empty draft is no draft. */
export function isEmptyDraft(draft: ChatDraft): boolean {
    return draft.text.trim() === '' && draft.pills.length === 0 && draft.attachments.length === 0;
}

/** Every stored file a draft points at: its attachments' refs, then its image pills'. */
export function draftRefs(draft: ChatDraft): string[] {
    const refs = [...draft.attachments.map((a) => a.ref), ...draft.pills.map((p) => (p.kind === 'image' ? p.file.ref : undefined))];
    return refs.filter((r): r is string => typeof r === 'string');
}

/** A ref Genie's store mints: a UUID, nothing else — so a ref can never name a path outside the store. */
export function isDraftRef(ref: unknown): ref is string {
    return typeof ref === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ref);
}

const str = (v: unknown): v is string => typeof v === 'string';

function readFileEntry(raw: unknown): ChatDraftFile | null {
    if (!raw || typeof raw !== 'object') return null;
    const f = raw as Record<string, unknown>;
    if (!str(f.id) || !str(f.name) || !str(f.type) || typeof f.bytes !== 'number') return null;
    return { id: f.id, name: f.name, type: f.type, bytes: f.bytes, ...(str(f.ref) ? { ref: f.ref } : {}) };
}

/** One draft read back, or `null` for anything that is not a v1 draft — a later version is refused, never guessed at. */
export function readChatDraft(raw: unknown): ChatDraft | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const d = raw as Record<string, unknown>;
    if (d.v !== 1 || !str(d.text) || !Array.isArray(d.pills) || !Array.isArray(d.attachments)) return null;
    const pills: ChatDraftPill[] = [];
    for (const p of d.pills as unknown[]) {
        if (!p || typeof p !== 'object') return null;
        const pill = p as Record<string, unknown>;
        if (pill.kind === 'text' && str(pill.id) && str(pill.text)) {
            pills.push({ kind: 'text', id: pill.id, text: pill.text });
            continue;
        }
        const file = pill.kind === 'image' && str(pill.id) && str(pill.label) ? readFileEntry(pill.file) : null;
        if (!file) return null;
        pills.push({ kind: 'image', id: pill.id as string, label: pill.label as string, file });
    }
    const attachments: ChatDraftFile[] = [];
    for (const a of d.attachments as unknown[]) {
        const file = readFileEntry(a);
        if (!file) return null;
        attachments.push(file);
    }
    return { v: 1, text: d.text, pills, attachments };
}

/**
 * Every chat's draft, read back. Genie 1's rule (`main/ask/draft-store.ts` parseDraftStore): anything unreadable is "no
 * drafts" — a lost draft is bad, a chat that cannot open is worse — and entries are checked one by one, so one bad row
 * cannot take the rest with it.
 */
export function parseChatDrafts(raw: unknown): ChatDrafts {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, ChatDraft> = {};
    for (const [agentId, value] of Object.entries(raw as Record<string, unknown>)) {
        const draft = readChatDraft(value);
        if (draft && !isEmptyDraft(draft)) out[agentId] = draft;
    }
    return out;
}

/** Keep only the drafts of agents that still exist (Genie 1's pruneDrafts): a deleted agent's draft goes with it. */
export function pruneChatDrafts(drafts: ChatDrafts, agentIds: Iterable<string>): ChatDrafts {
    const keep = new Set(agentIds);
    const ids = Object.keys(drafts);
    if (ids.every((id) => keep.has(id))) return drafts;
    return Object.fromEntries(ids.filter((id) => keep.has(id)).map((id) => [id, drafts[id]!]));
}
