// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProcessesPanel } from '../src/renderer/components/FeatureSurfaces.js';
import type { HostedProcess } from '../src/main/process-book.js';
import type { FeatureAction } from '../src/renderer/features.js';
import { ProcessSupervisor } from '../src/main/process-supervisor.js';
import { SupervisorService } from '../src/main/supervisor-host.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { buttonTexts } from './helpers/control-markup.js';

const NOW = 1_760_000_000_000;
const running: HostedProcess = { id: 'command-633', workspaceId: 'work', name: 'fixture · services exec', command: 'php artisan test', commandRun: true, state: 'running', pid: 123, exitCode: null, restarts: 0, since: NOW - 65_000, startedAt: NOW - 65_000, log: { text: 'live output', lines: 1, dropped: 0 } };
const workspaces = [{ id: 'work', path: '/fixture' }];
const markup = (process: HostedProcess, now = NOW) => renderToStaticMarkup(<ProcessesPanel processes={[process]} workspaces={workspaces} onAction={() => {}} now={now} />);
const row = (html: string) => html.slice(html.indexOf('data-process="command-633"'));
const words = (html: string) => row(html).replace(/<[^>]*>/g, '');
let host: HTMLDivElement; let root: Root;
beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] }); vi.setSystemTime(NOW);
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

describe('service commands in the existing Processes surface (#633)', () => {
    it('offers only Stop for a running one-shot command, never an unapproved Restart', () => {
        expect(buttonTexts(row(markup(running)))).toEqual(['Stop']);
    });

    it.each(['exited', 'failed', 'stopped'] as const)('keeps a %s command visible with its log and offers no Start or Restart', (state) => {
        const html = row(markup({ ...running, state, pid: null, exitCode: state === 'failed' ? 2 : 0, since: NOW }));
        expect(html).toContain('live output');
        expect(buttonTexts(html)).toEqual([]);
    });

    it('shows elapsed running time in human-readable units', () => {
        expect(words(markup(running))).toContain('Elapsed 1m 5s');
    });

    it('keeps completed duration and exit code fixed instead of counting time since exit', () => {
        const process: HostedProcess = { ...running, state: 'exited', pid: null, exitCode: 0, startedAt: NOW - 5_000, since: NOW };
        expect(words(markup(process, NOW + 60_000))).toContain('Duration 5s');
        expect(words(markup(process, NOW + 60_000))).toContain('exit 0');
    });

    it('ticks elapsed time in a mounted view even when the command emits no new output', () => {
        const process = { ...running, since: NOW, startedAt: NOW };
        act(() => root.render(<ProcessesPanel processes={[process]} workspaces={workspaces} onAction={() => {}} />));
        expect(host.querySelector('[data-process="command-633"]')?.textContent).toContain('Elapsed 0s');
        act(() => { vi.advanceTimersByTime(2_000); });
        expect(host.querySelector('[data-process="command-633"]')?.textContent).toContain('Elapsed 2s');
    });

    it('offers the live log before output arrives, and updates it without losing Stop', () => {
        act(() => root.render(<ProcessesPanel processes={[{ ...running, log: { text: '', lines: 0, dropped: 0 } }]} workspaces={workspaces} onAction={() => {}} now={NOW} />));
        expect(host.querySelector('[data-process-log="command-633"]')).not.toBeNull();
        expect(host.querySelector('[data-process="command-633"]')?.textContent).toContain('No output yet');
        act(() => root.render(<ProcessesPanel processes={[running]} workspaces={workspaces} onAction={() => {}} now={NOW} />));
        expect(host.querySelector('[data-process-log="command-633"] pre')?.textContent).toBe('live output');
        expect([...host.querySelectorAll<HTMLButtonElement>('[data-process="command-633"] button')].some((button) => button.textContent?.trim() === 'Stop')).toBe(true);
    });

    it('retains the actual command start in the host/replica snapshot after completion', () => {
        let now = NOW;
        const pty: PtyPort = { open: () => { throw new Error('must not spawn'); }, write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {} };
        const supervisor = new ProcessSupervisor(pty, { now: () => now, schedule: () => () => {} });
        const service = new SupervisorService(supervisor);
        const handle = supervisor.trackExternal({ id: 'timed', workspaceId: 'work', name: 'fixture', command: 'fixture', cwd: '/fixture' }, { pid: 123, stop: () => {} });
        expect(supervisor.status('timed')?.startedAt).toBe(NOW);
        now += 5_000; handle.finish(0);
        expect(service.dump().statuses[0]).toMatchObject({ startedAt: NOW, since: NOW + 5_000, state: 'exited' });
    });

    it('CONTROL: Stop is an actual Fancy button that sends the existing stopProcess action for exactly this run', () => {
        const actions: FeatureAction[] = [];
        act(() => root.render(<ProcessesPanel processes={[running]} workspaces={workspaces} onAction={(action) => { actions.push(action); }} now={NOW} />));
        const stop = [...host.querySelectorAll<HTMLButtonElement>('[data-process="command-633"] button')].find((button) => button.textContent?.trim() === 'Stop');
        expect(stop?.hasAttribute('data-react-fancy-button')).toBe(true);
        act(() => { stop!.click(); });
        expect(actions).toEqual([{ kind: 'hosting.stopProcess', processId: 'command-633' }]);
    });

    it('CONTROL: an old completed row without a reported start does not invent a duration', () => {
        const { startedAt: _startedAt, ...legacy } = running;
        const text = words(markup({ ...legacy, state: 'exited', pid: null, since: NOW, exitCode: 0 }));
        expect(text).not.toContain('Duration'); expect(text).not.toContain('NaN');
    });

    it.each(['running', 'stopped'] as const)('CONTROL: ordinary kept %s process retains its existing actions', (state) => {
        const { commandRun: _commandRun, startedAt: _startedAt, ...ordinary } = running;
        const html = row(markup({ ...ordinary, state, durable: true }));
        expect(buttonTexts(html)).toEqual(state === 'running' ? ['Stop', 'Restart'] : ['Start', 'Remove']);
    });
});
