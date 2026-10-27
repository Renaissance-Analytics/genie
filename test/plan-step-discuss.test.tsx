import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { pasteMarker } from '@particle-academy/react-fancy';
import type { ChatDraft } from '../src/core/chat-drafts.js';

/**
 * TALK ABOUT A PLAN STEP (genie#1280; the owner, 2026-10-27: "show a chat icon on item hover that, when clicked, sends a
 * styled pill to the user input (like the pasted image), so a user can talk about it").
 *
 * Each step of the Active Plan has an icon-only button, shown on hover and on keyboard focus. Its click puts a paste pill
 * into THAT agent's draft (genie#1261's per-chat composers) through react-fancy 5.65's `PromptInputHandle`
 * (`getDraft` / `setDraft`). Sent, the pill expands to the full step, quoted as a plan step.
 *
 * Focus: the click is the person's gesture, so the composer is focused after the insert (`setDraft(…, { focus: true })`).
 * Nothing else moves it (genie#1235): an insert not from a click passes `focus: false`, and no composer is ever given
 * `autoFocus`.
 *
 * No DOM (docs/decisions.md D3): the click is pressed on the hook-free view's element tree; the insert is proved on the
 * pure functions with a fake handle that records what it was asked to do.
 */
const seen = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@particle-academy/react-fancy', async (original) => {
    const real = await original<typeof import('@particle-academy/react-fancy')>();
    const PromptInput = (props: Record<string, unknown>) => { seen.push(props); return (real.PromptInput as unknown as { render: (p: unknown, ref: null) => unknown }).render(props, null); };
    return { ...real, PromptInput };
});
// Imported where used: on origin/main neither module exists, and a top-level import would fail every test for "not found".
const pill = () => import('../src/core/plan-pill.js') as Promise<Record<string, unknown>>;
const column = () => import('../src/renderer/components/PlanColumn.js') as Promise<Record<string, unknown>>;

type Props = Record<string, unknown>;
function findAll(node: ReactNode, match: (p: Props) => boolean, out: Props[] = []): Props[] {
    if (Array.isArray(node)) { for (const n of node) findAll(n, match, out); return out; }
    if (!isValidElement(node)) return out;
    const p = node.props as Props;
    if (match(p)) out.push(p);
    findAll(p.children as ReactNode, match, out);
    return out;
}

const steps = [
    { content: 'Read the brief', status: 'completed', current: false },
    { content: 'Write the migration for the accounts table', status: 'in_progress', current: true },
    { content: 'Run the suite', status: 'pending', current: false },
];
const viewProps = (extra: Props = {}) => ({ name: 'sable', plan: { step: 2, of: 3, doing: 'Write the migration' }, steps, width: 300, ...extra });
type View = (p: Props) => ReactNode;

describe('the chat icon on each plan step', () => {
    it('one per step, icon only, named by its aria-label; shown on hover AND on keyboard focus', async () => {
        const PlanColumnView = (await column()).PlanColumnView as View;
        expect(typeof PlanColumnView).toBe('function');
        const html = renderToStaticMarkup(<>{PlanColumnView(viewProps({ onDiscuss: () => {} }))}</>);
        // CONTROL for the icon-only check below: the same pattern finds a step's words.
        const words = />[^<]*[^<\s][^<]*</;
        expect('<span class="min-w-0 flex-1">Run the suite</span>').toMatch(words);
        // And it does not fire on bare markup, which is what an icon-only button is.
        expect('<button class="x"><span aria-hidden="true"></span></button>').not.toMatch(words);
        const buttons = html.match(/<button[^>]*data-plan-discuss="[^"]*"[^>]*>[\s\S]*?<\/button>/g) ?? [];
        expect(buttons.length).toBe(3);
        for (const b of buttons) {
            expect(b).toContain('aria-label="Discuss in chat"');
            // Icon only: no words inside the button but the icon's own markup.
            expect(b).not.toMatch(words);
            // Hidden until the step is hovered or the button has keyboard focus.
            expect(b).toMatch(/class="[^"]*\bopacity-0\b/);
            expect(b).toMatch(/class="[^"]*group-hover:opacity-100/);
            expect(b).toMatch(/class="[^"]*focus-visible:opacity-100/);
        }
        // The step is the hover group.
        expect(html).toMatch(/<li[^>]*class="[^"]*\bgroup\b[^"]*"[^>]*data-plan-step=|<li[^>]*data-plan-step=[^>]*class="[^"]*\bgroup\b/);
    });

    it('clicking a step’s icon hands up THAT step’s full text', async () => {
        const PlanColumnView = (await column()).PlanColumnView as View;
        const got: string[] = [];
        const tree = PlanColumnView(viewProps({ onDiscuss: (s: string) => got.push(s) }));
        const buttons = findAll(tree, (p) => p['data-plan-discuss'] !== undefined);
        expect(buttons.length).toBe(3);
        (buttons[1]!.onClick as () => void)();
        expect(got).toEqual(['Write the migration for the accounts table']);
    });

    it('the Agent view draws them when it is given somewhere to send a step (onDiscussStep)', async () => {
        const { AgentView } = await import('../src/renderer/components/AgentView.js');
        const agent = { id: 'a1', name: 'sable', provider: 'claude', fidelity: 'declared' as const, cwd: '/w/tynn', instructions: null };
        const session = { running: true, turnState: 'working', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: { step: 1, of: 2, doing: 'b' }, planSteps: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] };
        const draw = (extra: Props) => renderToStaticMarkup(<AgentView agent={agent} session={session as never} rows={[]} tab="stream" lanes={null} at={null} selectedId={null} turns={1} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 2_000} {...extra} />);
        expect((draw({ onDiscussStep: () => {} }).match(/data-plan-discuss=/g) ?? []).length).toBe(2);
        expect(draw({})).not.toContain('data-plan-discuss=');
    });

    it('CONTROL: with nowhere to send it (no onDiscuss), no icon — never a dead control', async () => {
        const PlanColumnView = (await column()).PlanColumnView as View;
        const html = renderToStaticMarkup(<>{PlanColumnView(viewProps())}</>);
        expect(html).toContain('data-plan-step=');
        expect(html).not.toContain('data-plan-discuss=');
    });
});

interface FakeHandle { draft: ChatDraft; calls: Array<{ draft: ChatDraft; focus: unknown }>; focused: number; getDraft(): ChatDraft; setDraft(d: ChatDraft, o?: { focus?: boolean }): void; focus(): void }
const handle = (draft: ChatDraft = { v: 1, text: '', pills: [], attachments: [] }): FakeHandle => {
    const h: FakeHandle = {
        draft, calls: [], focused: 0,
        getDraft: () => structuredClone(h.draft),
        setDraft: (d, o) => { h.calls.push({ draft: d, focus: o?.focus }); h.draft = d; },
        focus: () => { h.focused += 1; },
    };
    return h;
};

describe('the pill it makes', () => {
    it('react-fancy’s own marker, so the composer reads it as a pill', async () => {
        const { PILL_MARK } = await pill();
        expect(`${PILL_MARK as string}p1${PILL_MARK as string}`).toBe(pasteMarker('p1'));
    });

    it('a click on agent B’s step lands a pill in B’s draft — not A’s — whose text quotes the full step; kept, and focused', async () => {
        const { planStepInsert, applyChatInsert } = await pill() as {
            planStepInsert: (agentId: string, step: string, seq: number) => { agentId: string; focus: boolean; pill: { id: string; text: string } };
            applyChatInsert: (handles: ReadonlyMap<string, FakeHandle>, insert: unknown, keep?: (agentId: string, d: ChatDraft) => void) => boolean;
        };
        const a = handle({ v: 1, text: 'half typed to A', pills: [], attachments: [] });
        const b = handle({ v: 1, text: 'about this:', pills: [], attachments: [] });
        const kept: Array<[string, ChatDraft]> = [];
        const insert = planStepInsert('a_b', 'Write the migration for the accounts table', 7);
        expect(insert.agentId).toBe('a_b');
        expect(insert.focus).toBe(true);
        expect(insert.pill.text).toBe('Plan step: "Write the migration for the accounts table"');

        expect(applyChatInsert(new Map([['a_a', a], ['a_b', b]]), insert, (id, d) => kept.push([id, d]))).toBe(true);
        expect(a.calls).toEqual([]);
        expect(b.calls.length).toBe(1);
        const d = b.calls[0]!.draft;
        expect(d.v).toBe(1);
        expect(d.pills).toEqual([{ kind: 'text', id: insert.pill.id, text: 'Plan step: "Write the migration for the accounts table"', label: 'Write the migration for the accounts…' }]);
        // What was typed stays, the pill follows it, and the caret has room after it.
        expect(d.text).toBe(`about this: ${pasteMarker(insert.pill.id)} `);
        expect(b.calls[0]!.focus).toBe(true);
        // setDraft does not fire onDraftChange (react-fancy 5.65), so the insert is kept here, under B.
        expect(kept).toEqual([['a_b', d]]);
    });

    it('a second step adds a second pill; earlier pills and attachments stay', async () => {
        const { planStepInsert, applyChatInsert } = await pill() as {
            planStepInsert: (agentId: string, step: string, seq: number) => { pill: { id: string } };
            applyChatInsert: (handles: ReadonlyMap<string, FakeHandle>, insert: unknown) => boolean;
        };
        const b = handle();
        const one = planStepInsert('a_b', 'Read the brief', 1);
        const two = planStepInsert('a_b', 'Run the suite', 2);
        expect(one.pill.id).not.toBe(two.pill.id);
        applyChatInsert(new Map([['a_b', b]]), one);
        applyChatInsert(new Map([['a_b', b]]), two);
        expect(b.draft.pills.map((p) => p.id)).toEqual([one.pill.id, two.pill.id]);
        expect(b.draft.text).toBe(`${pasteMarker(one.pill.id)} ${pasteMarker(two.pill.id)} `);
    });

    it('that agent’s composer is not mounted yet: nothing applied, nothing lost — it waits', async () => {
        const { planStepInsert, applyChatInsert } = await pill() as {
            planStepInsert: (agentId: string, step: string, seq: number) => unknown;
            applyChatInsert: (handles: ReadonlyMap<string, FakeHandle>, insert: unknown) => boolean;
        };
        const a = handle();
        expect(applyChatInsert(new Map([['a_a', a]]), planStepInsert('a_b', 'Run the suite', 3))).toBe(false);
        expect(a.calls).toEqual([]);
    });
});

describe('nothing auto-focuses (genie#1235)', () => {
    it('an insert that is not the person’s click passes focus:false and never calls focus()', async () => {
        const { planStepInsert, applyChatInsert } = await pill() as {
            planStepInsert: (agentId: string, step: string, seq: number) => Record<string, unknown>;
            applyChatInsert: (handles: ReadonlyMap<string, FakeHandle>, insert: unknown) => boolean;
        };
        const b = handle();
        applyChatInsert(new Map([['a_b', b]]), { ...planStepInsert('a_b', 'Run the suite', 4), focus: false });
        expect(b.calls.length).toBe(1);
        expect(b.calls[0]!.focus).toBe(false);
        expect(b.focused).toBe(0);
    });

    it('every composer gets a ref (how the insert reaches it) and none gets autoFocus — not even with an insert waiting', async () => {
        const { ChatFlyout } = await import('../src/renderer/components/ChatFlyout.js');
        const { planStepInsert } = await pill() as { planStepInsert: (agentId: string, step: string, seq: number) => unknown };
        seen.length = 0;
        const thread = { agentId: 'a_b', name: 'wren', fidelity: 'declared' as const, unread: null, messages: [] };
        renderToStaticMarkup(<ChatFlyout thread={thread} onSend={() => {}} {...({ insert: planStepInsert('a_b', 'Run the suite', 5), onInserted: () => {} } as Record<string, unknown>)} />);
        expect(seen.length).toBeGreaterThan(0);
        for (const p of seen) {
            expect(typeof p.ref).toBe('function');
            expect('autoFocus' in p).toBe(false);
        }
    });
});
