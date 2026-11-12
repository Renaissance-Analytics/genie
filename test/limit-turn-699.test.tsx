import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { turnStopOffered } from '../src/core/agent-view.js';
import { chatThreadFrom } from '../src/core/chat-view.js';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { LiveSession } from '../src/core/roster.js';
import { AgentSession, LIMIT_RESUME_PROMPT, type DriverEvents, type SessionDriverFactory } from '../src/core/session.js';
import { openDurableStore } from '../src/core/thread-store.js';
import type { AgentDetail } from '../src/renderer/bridge.js';
import * as Flyout from '../src/renderer/components/ChatFlyout.js';

/*
 * TYNN #699 (seen on the coordinator agent, 2026-11-11). A Claude turn went silent after its reply at 18:48:41 — no turn end,
 * no limit reading — while the five-hour window stood at 97%. The person's two messages read "Queued · waiting for the
 * current turn to end" for 20 minutes, with no way to act on them, and only Restart got the agent back. These are what
 * the person needs when a turn will not end, and what a limit's reset or Resume now must do to a turn still open.
 */
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const noTree: ProcessTree = { snapshot: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };
const T0 = Date.UTC(2026, 10, 11, 18, 13, 0);

function open() {
    const dir = mkdtempSync(join(tmpdir(), 'genie2-699-'));
    dirs.push(dir);
    let events: DriverEvents = {};
    const sent: unknown[] = [];
    const cancels: number[] = [];
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        return { start: () => {}, prompt: (t: unknown) => { sent.push(t); }, cancel: () => { cancels.push(1); }, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } } as never;
    };
    const session = new AgentSession({ agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: factory, processTree: noTree });
    session.start();
    const reject = () => events.onUpdate?.({
        sessionUpdate: 'notice', notice: { level: 'info', message: 'You have hit your limit' },
        _meta: { 'particle.academy/rate_limit': { status: 'rejected', rateLimitType: 'five_hour', resetsAtMs: T0 + 3_600_000, windows: { five_hour: { utilization: 1, resetsAtMs: T0 + 3_600_000 } }, raw: {} } },
    });
    const endCancelled = () => events.onTurnEnd?.({ stopReason: 'cancelled', isError: false, raw: 'cancelled' });
    return { session, sent, cancels, reject, endCancelled };
}

describe('a turn that is still open when its limit is lifted', () => {
    it('Resume now (or the reset) ends the open turn, and what was queued behind it goes', async () => {
        const s = open();
        s.session.prompt('run the omarchy suite', 'you');
        s.reject();
        s.session.hold();
        // The person writes while the turn will not end: it waits.
        s.session.prompt('are you there?', 'you');
        expect(s.sent).toHaveLength(1);
        s.session.resumeAfterLimit();
        expect(s.cancels).toHaveLength(1);
        s.endCancelled();
        expect(s.sent.at(-1)).toContain('are you there?');
        expect(s.session.held).toBe(false);
    });

    it('with nothing queued, the turn the limit cut is told to continue once it has ended', () => {
        const s = open();
        s.session.prompt('run the omarchy suite', 'you');
        s.reject();
        s.session.hold();
        s.session.resumeAfterLimit();
        expect(s.cancels).toHaveLength(1);
        s.endCancelled();
        expect(String(s.sent.at(-1))).toContain(LIMIT_RESUME_PROMPT);
    });

    it('a held session with no turn open is resumed as before, and nothing is cancelled (CONTROL)', () => {
        const s = open();
        s.session.hold();
        s.session.prompt('later', 'you');
        expect(s.sent).toHaveLength(0);
        s.session.resumeAfterLimit();
        expect(s.cancels).toHaveLength(0);
        expect(s.sent.at(-1)).toContain('later');
    });
});

describe('Stop is there whenever a turn is open', () => {
    const live = (over: Partial<LiveSession>): LiveSession => ({ running: true, turnState: 'working', inTurn: true, cancelTurn: true, failure: null, ...over } as LiveSession);
    it('a turn Genie records as open offers Stop, whatever the state word reads', () => {
        expect(turnStopOffered(live({ turnState: 'idle', inTurn: true }))).toBe(true);
        expect(turnStopOffered(live({ turnState: 'working', inTurn: false }))).toBe(true);
    });
    it('no turn open, a failure, or no way to cancel: no Stop (CONTROL)', () => {
        expect(turnStopOffered(live({ turnState: 'idle', inTurn: false }))).toBe(false);
        expect(turnStopOffered(live({ failure: { reason: 'x', fixes: [], exit: null, at: null } as never }))).toBe(false);
        expect(turnStopOffered(live({ cancelTurn: false }))).toBe(false);
    });
});

describe('a message queued behind a silent turn', () => {
    const detail = (rowsAt: number): AgentDetail => ({
        agent: { id: 'a1', name: 'tynn', provider: 'claude', fidelity: 'declared', cwd: '/w' },
        session: { running: true, turnState: 'working', inTurn: true, cancelTurn: true, failure: null } as never,
        turns: 1, cost: null, refusal: null,
        rows: [
            { id: 'r1', event: { kind: 'message', speaker: 'agent', peerName: null, text: 'The full Omarchy run finished red.' }, at: rowsAt },
            { id: 'r2', event: { kind: 'message', speaker: 'you', peerName: null, text: 'are you there?', pending: { id: 'p1', content: null } }, at: rowsAt + 1 },
        ],
    } as unknown as AgentDetail);

    it('carries when the turn last said anything', () => {
        const thread = chatThreadFrom(detail(T0), 'a1', [], () => T0);
        const queued = thread.messages.find((m) => m.queued);
        expect(queued).toBeDefined();
        expect(queued!.silentSince).toBe(T0);
    });

    type Props = { id: string; agentName: string; silentSince: number | null; now: number; onSendNow?: () => void };
    const Note = () => {
        const C = (Flyout as unknown as { ChatQueuedNote?: (p: Props) => React.ReactElement }).ChatQueuedNote;
        expect(C, 'ChatQueuedNote').toBeTypeOf('function');
        return C!;
    };
    const render = (p: Props) => { const C = Note(); return renderToStaticMarkup(<C {...p} />); };

    it('after two minutes with nothing from the turn, it offers "Send now (stop the current turn)"', () => {
        const html = render({ id: 'p1', agentName: 'tynn', silentSince: T0, now: T0 + 120_000, onSendNow: () => {} });
        expect(html).toContain('Queued · waiting for the current turn to end');
        expect(html).toContain('data-action="send-now"');
        expect(html).toContain('Send now (stop the current turn)');
    });

    it('before two minutes, or with no way to stop the turn, it does not (CONTROL)', () => {
        expect(render({ id: 'p1', agentName: 'tynn', silentSince: T0, now: T0 + 119_000, onSendNow: () => {} })).not.toContain('data-action="send-now"');
        expect(render({ id: 'p1', agentName: 'tynn', silentSince: T0, now: T0 + 600_000 })).not.toContain('data-action="send-now"');
    });

    it('pressing it stops the turn so the message goes next', () => {
        const C = Note();
        const onSendNow = vi.fn();
        const element = C({ id: 'p1', agentName: 'tynn', silentSince: T0, now: T0 + 300_000, onSendNow });
        const find = (node: unknown): { props: { onClick?: () => void; 'data-action'?: string } } | null => {
            if (node === null || typeof node !== 'object') return null;
            const n = node as { props?: { 'data-action'?: string; children?: unknown } };
            if (n.props?.['data-action'] === 'send-now') return n as never;
            const kids = n.props?.children;
            for (const k of Array.isArray(kids) ? kids : [kids]) { const hit = find(k); if (hit) return hit; }
            return null;
        };
        find(element)!.props.onClick!();
        expect(onSendNow).toHaveBeenCalledOnce();
    });
});
