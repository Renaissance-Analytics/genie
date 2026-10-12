import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { processEnded } from '../src/core/agent-view.js';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { LiveSession } from '../src/core/roster.js';
import { AgentSession, type DriverEvents, type SessionDriver, type SessionDriverFactory } from '../src/core/session.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';
import { openDurableStore } from '../src/core/thread-store.js';
import { AgentView, type AgentOpsProps } from '../src/renderer/components/AgentView.js';

/**
 * THE PROCESS-ENDED BLOCK, two more facts from the board (error state): how the process ENDED — the exit code or the
 * signal, exactly as node reported it to the session's `onExit` — and the `Open terminal` door (a Take Over window on
 * the agent). Peak RSS stays absent: nothing reports it. An exit the session never saw renders nothing, not `exit 0`.
 */
const dirs: string[] = [];
function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'genie2-exit-'));
    dirs.push(d);
    return d;
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const noProcessTree: ProcessTree = { descendantsOf: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

function openSession() {
    let events: DriverEvents = {};
    let running = false;
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        const driver: SessionDriver = {
            start: () => { running = true; },
            prompt: () => {},
            kill: () => { running = false; },
            get running() { return running; },
            get cliSessionId() { return null; },
        };
        return driver;
    };
    const dir = tempDir();
    const session = new AgentSession({ agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: factory, processTree: noProcessTree });
    session.start();
    return { session, exit: (code: number | null, signal: NodeJS.Signals | null) => events.onExit?.(code, signal) };
}

describe('the session keeps how the process ended', () => {
    it('null until the exit; then the code or the signal node reported, verbatim', () => {
        const a = openSession();
        expect(a.session.exit).toBeNull();
        a.exit(1, null);
        expect(a.session.exit).toEqual({ code: 1, signal: null });

        const b = openSession();
        b.exit(null, 'SIGKILL');
        expect(b.session.exit).toEqual({ code: null, signal: 'SIGKILL' });
    });
});

const t = (id: string, event: StreamEvent): TimedEvent => ({ id, event, at: 1_000 });
const rows: TimedEvent[] = [t('t1', { kind: 'turn', n: 9, by: 'you' })];
const failed = (exit?: { code: number | null; signal: string | null } | null): LiveSession =>
    ({ running: false, turnState: 'failed', startedAt: 1, pendingApproval: null, failure: { reason: 'codex: acp: transport closed (EOF)', fixes: ['restart'], ...(exit === undefined ? {} : { exit }) }, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null }) as LiveSession;

describe('processEnded names the exit', () => {
    it('`exit N` for a code, `signal X` for a signal (the signal wins — a signalled process has no code), nothing otherwise', () => {
        // `processEnded` is null for a session that did not fail; these all failed, and the block's shape is the claim.
        expect(processEnded(failed({ code: 1, signal: null }), rows, [])?.exit).toBe('exit 1');
        expect(processEnded(failed({ code: null, signal: 'SIGKILL' }), rows, [])?.exit).toBe('signal SIGKILL');
        expect(processEnded(failed({ code: null, signal: null }), rows, [])?.exit).toBeNull();
        expect(processEnded(failed(null), rows, [])?.exit).toBeNull();
        expect(processEnded(failed(), rows, [])?.exit).toBeNull();
        expect(processEnded(failed(), rows, [])).not.toBeNull();
    });
});

describe('the block in the Agent view', () => {
    const agent = { id: 'a1', name: 'sable', provider: 'codex', fidelity: 'declared' as const, cwd: '/w/tynn', instructions: null };
    const ops: AgentOpsProps = { mode: 'manual', accessScope: 'self', budgetUsd: null, deletePreview: null, diagnosis: null, lastOutcome: null, onRestart: () => {}, onSwitchDriver: () => {}, onDiagnose: () => {}, onPreviewDelete: () => {}, onConfirmDelete: () => {}, onCancelDelete: () => {}, onSetMode: () => {}, onSetAccessScope: () => {}, onSetBudget: () => {} };
    const render = (props: Partial<Parameters<typeof AgentView>[0]> = {}) =>
        renderToStaticMarkup(<AgentView agent={agent} session={failed({ code: 137, signal: null })} rows={rows} tab="stream" lanes={null} at={null} selectedId={null} turns={9} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 2_000} workspace={{ id: 'tynn', name: 'Tynn.ai', path: '/w/tynn' }} ops={ops} {...props} />);

    // The block's own markup, so the header's `Open terminal` (the same door, further away) cannot satisfy the claim.
    const block = (html: string): string => html.slice(html.indexOf('data-rail="process-ended"'), html.indexOf('</section>', html.indexOf('data-rail="process-ended"')));

    it('shows the exit line and the Open terminal door, in the block', () => {
        const html = render({ onTakeOver: () => {} });
        expect(block(html)).toContain('data-exit="exit 137"');
        expect(block(html)).toContain('data-action="open-terminal-rail"');
        expect(block(html)).toContain('Open terminal');
    });

    it('no exit line when none was reported — the block itself still there, with its door', () => {
        const html = render({ session: failed() });
        expect(html).toContain('data-rail="process-ended"');
        expect(block(html)).not.toContain('data-exit=');
        expect(block(html)).toContain('data-action="open-terminal-rail"');
    });
});
