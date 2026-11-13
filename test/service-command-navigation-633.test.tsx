// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ledgerRow } from '../src/core/stream-view.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { CommandRunRef } from '../src/core/command-run.js';
import { formatRoute, parseRoute, type Route } from '../src/core/route.js';
import { addressOf, routeOfAddress } from '../src/core/address.js';
import { StreamRow, type StreamMarkup } from '../src/renderer/components/StreamRow.js';
import { ProcessesPanel } from '../src/renderer/components/FeatureSurfaces.js';
import type { HostedProcess } from '../src/main/process-book.js';

const NOW = 1_760_000_000_000;
const run: CommandRunRef = { processId: 'command-one', workspaceId: 'work', command: 'php artisan test' };
const notice = (ref = run) => ledgerRow({ id: ref.processId, at: NOW, event: { kind: 'notice', level: 'info', message: `Started ${ref.command} via services`, commandRun: ref } });
const route = (ref = run): Route => ({ surface: 'hosting', tab: 'processes', commandRun: { processId: ref.processId, workspaceId: ref.workspaceId }, chat: null, pin: null });
const process = (id: string, workspaceId = 'work'): HostedProcess => ({ id, workspaceId, name: 'fixture · services exec', command: run.command, commandRun: true, state: 'exited', pid: null, exitCode: 0, restarts: 0, since: NOW, startedAt: NOW - 1000, log: { text: `output from ${id}`, lines: 1, dropped: 0 } });
let host: HTMLDivElement; let root: Root;
beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const markup = (open = vi.fn()): StreamMarkup => ({ refs: { files: false, agents: [], workspaces: [] }, onOpen: vi.fn(), onCommandRun: open });
function panel(processes: HostedProcess[], target = run) {
    const action = vi.fn();
    act(() => root.render(<ProcessesPanel processes={processes} workspaces={[{ id: 'work', path: '/fixture' }]} onAction={action} commandRun={target} now={NOW} />));
    return action;
}

describe('clickable exact command navigation (#633)', () => {
    it('keeps the host reference when presenting a recorded notice as a ledger row', () => {
        expect(notice().commandRun).toEqual(run);
    });

    it('opens the exact run only on the person clicking its real button, without inspecting a tool', () => {
        const open = vi.fn(); const select = vi.fn();
        act(() => root.render(<StreamRow row={notice()} selected={false} onSelect={select} markup={markup(open)} />));
        expect(open).not.toHaveBeenCalled();
        const button = host.querySelector<HTMLButtonElement>('button');
        expect(button, 'a host command notice has an actionable run button').not.toBeNull();
        expect(button!.querySelector('button,a')).toBeNull();
        act(() => button!.click());
        expect(open).toHaveBeenCalledExactlyOnceWith(run);
        expect(select).not.toHaveBeenCalled();
    });

    it('identical command labels open their own distinct runs instead of the first text match', () => {
        const open = vi.fn(); const other = { ...run, processId: 'command-two' };
        act(() => root.render(<>{[run, other].map((ref) => <StreamRow key={ref.processId} row={notice(ref)} selected={false} onSelect={() => {}} markup={markup(open)} />)}</>));
        const buttons = host.querySelectorAll<HTMLButtonElement>('button');
        expect(buttons).toHaveLength(2);
        act(() => buttons[1]!.click());
        expect(open).toHaveBeenCalledExactlyOnceWith(other);
    });

    it('retains exact process and workspace IDs through internal route encoding, without command text', () => {
        const exact = { ...run, processId: 'command/id & two', workspaceId: 'workspace & two' };
        const encoded = formatRoute(route(exact));
        expect(parseRoute(encoded)).toMatchObject(route(exact));
        expect(encoded).not.toContain('artisan');
    });

    it('retains the run selector when naming and reopening the currently connected remote workstation', () => {
        const ctx = { workstation: 'measurement-vm', workspaces: [], agents: [] };
        const named = addressOf(formatRoute(route()), ctx);
        expect(new URL(named).hostname).toBe('measurement-vm');
        expect(parseRoute(routeOfAddress(named, ctx)!)).toMatchObject(route());
    });

    it('opens and focuses only the selected exact run log even when command labels are identical', () => {
        const target = { ...run, processId: 'command-two' };
        const action = panel([process(run.processId), process(target.processId)], target);
        const first = host.querySelector<HTMLDetailsElement>('[data-process-log="command-one"]');
        const selected = host.querySelector<HTMLDetailsElement>('[data-process-log="command-two"]');
        expect(first?.open).toBe(false);
        expect(selected?.open).toBe(true);
        expect(document.activeElement).toBe(host.querySelector('[data-process="command-two"]'));
        expect(action).not.toHaveBeenCalled();
    });

    it('does not open a matching process ID belonging to another workspace', () => {
        const action = panel([process(run.processId, 'someone-else')]);
        expect(host.textContent).toContain('This command is not in the current process history.');
        expect([...host.querySelectorAll<HTMLDetailsElement>('details')].some((details) => details.open)).toBe(false);
        expect(action).not.toHaveBeenCalled();
    });

    it('says when bounded history no longer contains the run and never reruns it', () => {
        const action = panel([]);
        expect(host.textContent).toContain('This command is not in the current process history.');
        expect(action).not.toHaveBeenCalled();
    });

    it('does not turn an ordinary worker with a matching ID into a command target', () => {
        const { commandRun: _flag, ...ordinary } = process(run.processId);
        const action = panel([{ ...ordinary, durable: true }]);
        expect(host.textContent).toContain('This command is not in the current process history.');
        expect([...host.querySelectorAll<HTMLDetailsElement>('details')].some((details) => details.open)).toBe(false);
        expect(action).not.toHaveBeenCalled();
    });

    it('CONTROL: a view without a run opener keeps the recorded notice as plain text', () => {
        act(() => root.render(<StreamRow row={notice()} selected={false} onSelect={() => {}} />));
        expect(host.querySelector('button')).toBeNull();
        expect(host.textContent).toContain('Started php artisan test via services');
    });

    it('CONTROL: an ordinary notice never gains a command action', () => {
        const event: StreamEvent = { kind: 'notice', level: 'warning', message: 'ordinary notice' };
        const open = vi.fn();
        act(() => root.render(<StreamRow row={ledgerRow({ id: 'ordinary', at: NOW, event })} selected={false} onSelect={() => {}} markup={markup(open)} />));
        expect(host.querySelector('button')).toBeNull();
        expect(host.textContent).toContain('ordinary notice');
        expect(open).not.toHaveBeenCalled();
    });

    it('CONTROL: partial selectors are ignored and ordinary Hosting routes keep their existing meaning', () => {
        for (const query of ['', '?tab=processes', '?tab=processes&process=command-one', '?tab=processes&workspace=work']) {
            expect(parseRoute(`genie://hosting${query}`)).not.toHaveProperty('commandRun');
        }
    });
});
