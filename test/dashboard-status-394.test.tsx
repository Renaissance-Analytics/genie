// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shownState, type AgentRow } from '../src/core/dashboard-view.js';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { parseRoute } from '../src/core/route.js';
import { agentRowFor, type LiveSession } from '../src/core/roster.js';
import { Dashboard } from '../src/renderer/components/Dashboard.js';
import { statePill } from '../src/core/agent-view.js';
import { chatContext } from '../src/core/chat-view.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const row = (id: string, state: string, workspaceId = 'awake'): AgentRow => ({
    id, name: id, provider: 'claude', workspaceId, fidelity: 'declared', state: state as AgentRow['state'],
    duration: null, ask: null, reason: null, fixes: [], step: null, target: null, activity: null,
    delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
});
const workspaces = [{ id: 'awake', name: 'Active project', path: '/active' }];
let root: Root | null = null;
let container: HTMLDivElement;
function render(rows: AgentRow[]) {
    container = document.createElement('div'); document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(<Dashboard rows={rows} workspaces={workspaces} onOpenAgent={() => {}} onAddAgent={() => {}} />));
    return container;
}
afterEach(() => { if (root) act(() => root!.unmount()); root = null; document.body.innerHTML = ''; localStorage.clear(); vi.useRealTimers(); });
const agents = () => [...container.querySelectorAll('[data-agent]')].map((el) => el.getAttribute('data-agent'));
const filter = (kind: string) => container.querySelector<HTMLButtonElement>(`button[data-dashboard-filter="${kind}"]`);
function click(button: HTMLButtonElement | null) { expect(button).not.toBeNull(); act(() => button!.click()); }

describe('story 394: one alphabetical status table', () => {
    it('sorts globally by name across states and workspaces, with no grouping controls or headers', () => {
        render([row('Zulu', 'waiting'), row('alpha', 'idle'), row('Beta', 'working')]);
        expect(agents()).toEqual(['alpha', 'Beta', 'Zulu']);
        expect(container.querySelector('[data-group-toggle], [data-status-group], [data-workspace-head], [data-genie-group]')).toBeNull();
        expect(container.textContent).not.toContain('By workspace');
        expect(container.textContent).not.toContain('By status');
    });
    it('puts a named Workspace column on every row', () => {
        render([row('alpha', 'idle'), row('Beta', 'working')]);
        expect([...container.querySelectorAll('[data-agent] [data-column="workspace"]')].map((el) => el.textContent)).toEqual(['Active project', 'Active project']);
        expect(container.textContent).toContain('Workspace');
    });
    it.each(['genie://dashboard', 'genie://dashboard?group=status', 'genie://dashboard?group=workspace'])('removes the obsolete group route option: %s', (route) => {
        expect(parseRoute(route)).not.toHaveProperty('group');
    });
    it('hides Sleeping and Stopped separately, with persistent count Buttons', () => {
        const rows = [row('alpha', 'idle'), row('nap', 'sleeping'), row('quit', 'stopped')];
        render(rows);
        expect(agents()).toEqual(['alpha']);
        expect(filter('sleeping')?.textContent).toMatch(/Sleeping.*1|1.*Sleeping/);
        expect(filter('stopped')?.textContent).toMatch(/Stopped.*1|1.*Stopped/);
        click(filter('sleeping'));
        expect(filter('sleeping')?.getAttribute('aria-pressed')).toBe('true');
        expect(agents()).toEqual(['alpha', 'nap']);
        act(() => root!.unmount()); root = null; container.remove();
        render(rows);
        expect(agents()).toEqual(['alpha', 'nap']);
        click(filter('stopped'));
        expect(agents()).toEqual(['alpha', 'nap', 'quit']);
        click(filter('sleeping'));
        expect(agents()).toEqual(['alpha', 'quit']);
    });
    it('does not steal a focused filter Button’s Enter key for row navigation', () => {
        render([row('alpha', 'idle'), row('nap', 'sleeping')]);
        const button = filter('sleeping'); expect(button).not.toBeNull(); button!.focus();
        const press = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        act(() => button!.dispatchEvent(press));
        expect(press.defaultPrevented).toBe(false);
    });
    it('accents the whole row and its chip from the same status colour, including grey sleeping and red stopped', () => {
        render(['working', 'waiting', 'broken', 'cooling', 'idle', 'sleeping', 'stopped'].map((state) => row(state, state)));
        click(filter('sleeping')); click(filter('stopped'));
        for (const state of ['working', 'waiting', 'broken', 'cooling', 'idle', 'sleeping', 'stopped']) {
            const entry = container.querySelector<HTMLElement>(`[data-agent="${state}"]`)!;
            expect(entry.style.getPropertyValue('--agent-status')).not.toBe('');
            // Cooling keeps its colour while its census remains in Working, as before.
            if (state !== 'cooling') {
                const chip = container.querySelector<HTMLElement>(`[data-chip="${state}"]`)!;
                expect(chip.style.getPropertyValue('--agent-status')).toBe(entry.style.getPropertyValue('--agent-status'));
            }
            expect(entry.className).toContain('var(--agent-status)');
        }
        expect(container.querySelector<HTMLElement>('[data-agent="sleeping"]')!.style.getPropertyValue('--agent-status')).toMatch(/grey|gray|zinc|fg-4/);
        expect(container.querySelector<HTMLElement>('[data-agent="stopped"]')!.style.getPropertyValue('--agent-status')).toBe('var(--danger)');
    });
});

const record = agentRecord({ id: mintAgentId(), workspaceId: 'awake', name: 'alpha', provider: 'claude' });
const live = (over: Partial<LiveSession> & { idleSince?: number | null } = {}): LiveSession => ({
    running: true, turnState: 'idle', startedAt: 1, pendingApproval: null, failure: null,
    contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null, model: null, ...over,
});
describe('story 394: display-only Sleeping and Stopped', () => {
    it('the agent header and chat agree about Sleeping, and background work remains Working', () => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(400_000);
        const asleep = live({ idleSince: 1 });
        expect(statePill(asleep, Date.now, { turns: 1 }).word).toBe('Sleeping');
        expect(chatContext({ agent: { id: record.id, name: record.name, provider: record.provider, fidelity: 'declared' }, session: asleep, rows: [] }).text).toBe('Sleeping');
        expect(statePill(live({ idleSince: 1, background: 1 }), Date.now, { turns: 1 }).word).toMatch(/^Working/);
    });
    it('crosses five minutes of idle at the exact boundary', () => {
        expect(agentRowFor(record, live({ idleSince: 10_000 }), () => 309_999).state).toBe('idle');
        expect(agentRowFor(record, live({ idleSince: 10_000 }), () => 310_000).state).toBe('sleeping');
    });
    it('keeps background work Working and a new turn wakes Sleeping immediately', () => {
        expect(agentRowFor(record, live({ idleSince: 1 }), () => 400_000).state).toBe('sleeping');
        const background = agentRowFor(record, live({ idleSince: 1, background: 1 }), () => 400_000);
        expect(background.state).toBe('idle'); // The chat is still idle; only its displayed state is Working.
        expect(shownState(background)).toBe('working');
        expect(agentRowFor(record, live({ idleSince: null, turnState: 'working' }), () => 400_000).state).toBe('working');
    });
    it('calls stopped processes and stopped turns Stopped, while preserving Broken failures', () => {
        expect(agentRowFor(record, null, () => 400_000).state).toBe('stopped');
        expect(agentRowFor(record, live({ running: false }), () => 400_000).state).toBe('stopped');
        expect(agentRowFor(record, live({ turnState: 'stopped' }), () => 400_000).state).toBe('stopped');
        expect(agentRowFor(record, live({ running: false, failure: { reason: 'provider failed', fixes: ['Restart'] } }), () => 400_000).state).toBe('broken');
    });
});
