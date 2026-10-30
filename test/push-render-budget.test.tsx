// @vitest-environment happy-dom
/**
 * A PUSH COSTS WHAT IT CHANGED; TYPING COMES FIRST (genie#1340; the owner on beta.52: "I am typing but it took 4 seconds
 * before the text showed up").
 *
 * Measured in the real window on omarchy-test (scripts/perf-lag/, eleven agents streaming, typing in the long thread's
 * chat): the renderer was busy about half of every second, and keystroke → paint was 140 ms–1 s at p95. The profile:
 *  - every ESTATE snapshot (20 a second while any agent works) drew the whole Agent view again — AgentView 7.5–10.4 s, its
 *    per-render index (`agentIndex`/`turnsOf`) 2.9 s — and so react-fancy's VirtualList measured every visible row again
 *    in a layout effect (3–5 s of self time, a forced layout each pass). Nothing the view shows had changed: it is one
 *    agent's page, and another agent's status moved;
 *  - the Agent view was handed a NEW `workspace` object by every snapshot, so its effects keyed on it re-ran: a
 *    `files.state` IPC to main per snapshot, and the persona file read again;
 *  - every pushed update rendered synchronously (React's default lane is not time-sliced), so a keystroke that arrived
 *    meanwhile waited for the whole render.
 *
 * This file renders the real Shell in a DOM (happy-dom, scoped to this file; docs/decisions.md D4) and COUNTS renders
 * (renderer/render-count.ts).
 */
import { act, useLayoutEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { ChatDraftKeeper } from '../src/core/chat-draft-keeper.js';
import { Shell } from '../src/renderer/Shell.js';
import { EMPTY_SNAPSHOT, NO_FILES, type AgentDetail, type GenieBridge, type GenieSnapshot } from '../src/renderer/bridge.js';
import type { ChatThread } from '../src/renderer/components/ChatFlyout.js';

type Counts = Record<string, number>;
const g = globalThis as { __genieRenders?: Counts; IS_REACT_ACT_ENVIRONMENT?: boolean };
const renders = (): Counts => g.__genieRenders!;
const reset = (): void => { g.__genieRenders = {}; };
const n = (name: string): number => renders()[name] ?? 0;

function row(over: Partial<AgentRow>): AgentRow {
    return { id: 'x', name: 'x', provider: 'claude', workspaceId: 'ws_alpha', fidelity: 'declared', state: 'idle', duration: null, ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null, ...over } as AgentRow;
}
const at0 = Date.UTC(2026, 9, 30, 9, 0, 0);
const tool = (i: number): TimedEvent => ({ id: `r${i}`, at: at0 + i * 1000, event: { kind: 'tool', toolCallId: `c${i}`, name: 'Bash', title: `npm test ${i}`, status: 'completed', toolKind: 'execute', rawInput: { command: `npm test ${i}` } } } as TimedEvent);

/** The estate as main sends it: every push is a NEW object graph (structured clone over IPC), equal or not. */
const estate = (wrenState: AgentRow['state']): GenieSnapshot => structuredClone({
    ...EMPTY_SNAPSHOT,
    agents: [row({ id: 'a_atlas', name: 'atlas', state: 'working' }), row({ id: 'a_wren', name: 'wren', state: wrenState }), row({ id: 'a_lark', name: 'lark', workspaceId: 'ws_beta' })],
    workspaces: [{ id: 'ws_alpha', path: '/w/alpha', name: 'alpha', agentsKnown: true }, { id: 'ws_beta', path: '/w/beta', name: 'beta', agentsKnown: true }],
    deckItems: [],
} as GenieSnapshot);

const detail = (rowCount: number): AgentDetail => ({
    agent: { id: 'a_atlas', name: 'atlas', workspaceId: 'ws_alpha', provider: 'claude', fidelity: 'declared', cwd: '/w/alpha', instructions: '.agents/atlas/AGENT.md' },
    session: null,
    rows: Array.from({ length: rowCount }, (_, i) => tool(i)),
    turns: 1,
    cost: null,
    refusal: null,
});
const thread: ChatThread = {
    agentId: 'a_atlas', name: 'atlas', fidelity: 'declared', unread: null, loaded: true,
    messages: Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, who: 'agent' as const, from: 'atlas', text: `Reply **${i}** with \`code\`.`, delivered: true, at: null })),
};

describe('a push costs what it changed (the real Shell, rendered)', () => {
    let host: HTMLElement;
    let root: Root;
    const files = { ...NO_FILES, state: vi.fn(NO_FILES.state), open: vi.fn(NO_FILES.open) };
    const keeper = new ChatDraftKeeper({ load: async () => ({}), save: async () => {}, putFile: async () => null, readFile: async () => null, release: async () => {} }, { setTimer: () => 0, clearTimer: () => {} });
    const onSelectRow = (): void => {};
    const draw = (snapshot: GenieSnapshot, agentDetail: AgentDetail, chatThread: ChatThread = thread) => (
        <Shell
            route="genie://agent/a_atlas?tab=stream&chat=a_atlas"
            snapshot={snapshot}
            servable={['dashboard', 'deck', 'agent', 'workspace']}
            agentDetail={agentDetail}
            agentResolved
            selectedRowId={null}
            chatThread={chatThread}
            chatDrafts={keeper}
            openedThreads={['a_atlas']}
            pinned={null}
            files={files}
            onNavigate={() => {}}
            onOpenAgent={() => {}}
            onAddAgent={() => {}}
            onAddWorkspace={() => {}}
            onOpenPalette={() => {}}
            onSelectRow={onSelectRow}
            onSend={() => {}}
            onToggleFilesPin={() => {}}
            onCloseChat={() => {}}
            answeringApproval={null}
            onAnswerApproval={() => {}}
            onAnswerDeckItem={() => {}}
        />
    );

    beforeEach(async () => {
        g.IS_REACT_ACT_ENVIRONMENT = true;
        await keeper.load();
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        reset();
    });
    afterEach(() => {
        act(() => root.unmount());
        host.remove();
        delete g.__genieRenders;
        files.state.mockClear();
        files.open.mockClear();
    });

    it('another agent’s status changing re-renders no part of this agent’s page, measures no row, and asks main for nothing', async () => {
        const mine = detail(40);
        await act(async () => root.render(draw(estate('idle'), mine)));
        // POSITIVE CONTROL: the counters count, and the page is this agent's.
        expect(n('AgentView')).toBeGreaterThan(0);
        expect(n('StreamRow')).toBeGreaterThan(0);
        expect(n('ChatReply')).toBeGreaterThan(0);
        expect(host.querySelector('[data-stream="rows"]')).not.toBeNull();

        reset();
        files.state.mockClear();
        files.open.mockClear();
        const measured = vi.spyOn(Element.prototype, 'getBoundingClientRect');
        // wren starts working: a new estate snapshot, equal for atlas, as main sends it.
        await act(async () => root.render(draw(estate('working'), mine)));
        const rowsMeasured = measured.mock.contexts.filter((el) => (el as Element).hasAttribute?.('data-react-fancy-virtual-row-id')).length;
        measured.mockRestore();

        // POSITIVE CONTROL: the push reached the window (the rail draws the estate).
        expect(n('Sidebar')).toBeGreaterThan(0);
        expect({
            AgentView: n('AgentView'), Stream: n('Stream'), StreamRow: n('StreamRow'), ChatFlyout: n('ChatFlyout'), ChatReply: n('ChatReply'),
            rowsMeasured, filesState: files.state.mock.calls.length, filesOpen: files.open.mock.calls.length,
        }).toEqual({ AgentView: 0, Stream: 0, StreamRow: 0, ChatFlyout: 0, ChatReply: 0, rowsMeasured: 0, filesState: 0, filesOpen: 0 });
    });

    it('this agent’s own push draws only its new row (and the chat, whose thread it is, none of its unchanged replies)', async () => {
        const before = detail(40);
        await act(async () => root.render(draw(estate('idle'), before)));
        reset();
        // The host keeps unchanged rows by identity (core/agent-push-wire.ts): one row appended.
        const after: AgentDetail = { ...before, rows: [...before.rows, tool(40)] };
        const grown: ChatThread = { ...thread, messages: [...thread.messages, { id: 'm12', who: 'agent', from: 'atlas', text: 'one more', delivered: true, at: null }] };
        await act(async () => root.render(draw(estate('idle'), after, grown)));
        // POSITIVE CONTROL: the view did draw for its own agent's push.
        expect(n('AgentView')).toBeGreaterThan(0);
        expect({ StreamRow: n('StreamRow'), ChatReply: n('ChatReply') }).toEqual({ StreamRow: 1, ChatReply: 1 });
    });

    it('a keystroke in the composer re-renders no thread row, no Stream row and not the Agent view', async () => {
        await act(async () => root.render(draw(estate('idle'), detail(40))));
        const change = vi.spyOn(keeper, 'change');
        reset();
        const box = host.querySelector<HTMLElement>('[data-chat-composer] [contenteditable="true"], [data-chat-composer] textarea');
        expect(box).not.toBeNull();
        await act(async () => {
            if (box instanceof HTMLTextAreaElement) {
                Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'h');
            } else {
                box!.textContent = 'h';
            }
            box!.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'h', inputType: 'insertText' }));
        });
        // POSITIVE CONTROL: the keystroke reached the composer — its draft changed to what was typed.
        expect(change).toHaveBeenCalled();
        expect(JSON.stringify(change.mock.calls.at(-1)![1])).toContain('h');
        expect({ StreamRow: n('StreamRow'), ChatReply: n('ChatReply'), AgentView: n('AgentView'), Stream: n('Stream') }).toEqual({ StreamRow: 0, ChatReply: 0, AgentView: 0, Stream: 0 });
        change.mockRestore();
    });
});

describe('typing comes first: a pushed estate update yields to a keystroke', () => {
    afterEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true; });

    it('a keystroke arriving while a push is being drawn is committed BEFORE the push (the push is a transition)', async () => {
        // Real scheduling, as in the window: no act() batching.
        g.IS_REACT_ACT_ENVIRONMENT = false;
        const { useSnapshot } = await import('../src/renderer/use-snapshot.js');
        let listener: ((s: GenieSnapshot) => void) | null = null;
        const bridge = { snapshot: () => Promise.resolve(EMPTY_SNAPSHOT), subscribe: (l: (s: GenieSnapshot) => void) => { listener = l; return () => { listener = null; }; } } as unknown as GenieBridge;
        const order: string[] = [];
        let input: HTMLInputElement | null = null;
        let typedOnce = false;
        const type = (): void => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input!, 'h');
            input!.dispatchEvent(new Event('input', { bubbles: true }));
        };
        // A view that takes a while to draw for a push: 12 × 15 ms.
        function Slow({ agents }: { agents: number }) {
            const t = performance.now();
            while (performance.now() - t < 15) { /* the cost of drawing */ }
            // The person types while the push is being drawn: on the first slice of that render.
            if (agents > 0 && !typedOnce) { typedOnce = true; setTimeout(type, 0); }
            return null;
        }
        function Probe() {
            const snapshot = useSnapshot(bridge);
            const [typed, setTyped] = useState('');
            useLayoutEffect(() => { if (typed !== '') order.push('keystroke'); }, [typed]);
            useLayoutEffect(() => { if (snapshot.agents.length > 0) order.push('push'); }, [snapshot]);
            return (
                <>
                    <input ref={(el) => { input = el; }} value={typed} onChange={(e) => setTyped(e.target.value)} />
                    {Array.from({ length: 12 }, (_, i) => <Slow key={i} agents={snapshot.agents.length} />)}
                </>
            );
        }
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        root.render(<Probe />);
        const until = async (ok: () => boolean): Promise<void> => { for (let i = 0; i < 500 && !ok(); i += 1) await new Promise((r) => setTimeout(r, 10)); };
        await until(() => listener !== null && input !== null);
        await new Promise((r) => setTimeout(r, 50));
        listener!(estate('working'));
        await until(() => order.length >= 2);
        root.unmount();
        host.remove();
        // Positive control in the same run: both happened.
        expect([...order].sort()).toEqual(['keystroke', 'push']);
        expect(order).toEqual(['keystroke', 'push']);
    });
});
