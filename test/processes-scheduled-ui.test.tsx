import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HostedProcess } from '../src/main/process-book.js';
import { ProcessesPanel } from '../src/renderer/components/FeatureSurfaces.js';
import type { FeatureAction } from '../src/renderer/features.js';
import { Button } from '@particle-academy/react-fancy';
import { AddProcessForm } from '../src/renderer/components/AddForms.js';
import { RowIconButton, RowMenu } from '../src/renderer/components/RowMenu.js';


/**
 * SCHEDULED TASKS IN HOSTING → PROCESSES (genie#1204), as Genie 1's Processes showed them
 * (renderer/components/Master/WorkspaceProcessManager.tsx and lib/process-manager.ts `processCard` at v0.7.0-beta.342):
 * a "scheduled" badge; "Scheduled" or "Paused — not firing" (or "Running now"); the schedule in words, the next run, the
 * last run; for a nudge, the prompt it sends; Run now, Pause schedule / Enable schedule, Remove. The add form takes a
 * schedule from Genie 1's presets ("No schedule (run as a service)" by default).
 */

const NOW = new Date(2026, 9, 26, 2, 0, 0).getTime();
const base = { workspaceId: 'tynn', pid: null, exitCode: null, restarts: 0, since: NOW, durable: true as const };
const nightly: HostedProcess = { ...base, id: 'p1', name: 'nightly report', state: 'stopped', command: 'npm run report', schedule: { cron: '0 3 * * *', kind: 'command', enabled: true, nextRunAt: new Date(2026, 9, 26, 3, 0, 0).getTime(), lastRunAt: NOW - 3_600_000, lastRunStatus: 'failed' } };
const paused: HostedProcess = { ...base, id: 'p2', name: 'prune', state: 'stopped', command: 'npm run prune', schedule: { cron: '*/15 * * * *', kind: 'command', enabled: false, nextRunAt: null } };
const nudge: HostedProcess = { ...base, id: 'p3', name: 'standup', state: 'stopped', schedule: { cron: '0 9 * * 1-5', kind: 'agent-nudge', prompt: 'post the standup', agent: 'atlas@tynn', enabled: true, nextRunAt: NOW + 7 * 3_600_000 } };
const queue: HostedProcess = { ...base, id: 'p4', name: 'queue', state: 'running', command: 'php artisan queue:work' };
const workspaces = [{ id: 'tynn', path: '/w/tynn' }];

/** A row's buttons by accessible name: its icon buttons, then "More actions" when the row has a menu (Tynn #708). */
const names = (html: string) => [...html.matchAll(/<button\b[^>]*>/g)].map((m) => /aria-label="([^"]*)"/.exec(m[0])?.[1] ?? '');
const rowOf = (html: string, id: string) => { const s = html.indexOf(`data-process="${id}"`); const e = html.indexOf('data-process="', s + 1); return html.slice(s, e === -1 ? undefined : e); };

describe('a scheduled task in Processes', () => {
    it('shows it is scheduled, its schedule in words, the next and the last run, and offers Run now, with Pause schedule and Remove in the menu', () => {
        const html = renderToStaticMarkup(<ProcessesPanel processes={[nightly, paused, nudge, queue]} workspaces={workspaces} onAction={() => {}} now={NOW} />);
        const row = rowOf(html, 'p1');
        expect(row).toContain('scheduled');
        expect(row).toContain('Scheduled');
        expect(row).toContain('Daily at 03:00');
        expect(row).toMatch(/Next run: in 1 hr/);
        expect(row).toMatch(/Last run: Failed 1 hr ago/);
        expect(names(row)).toEqual(['Run now', 'More actions']);
    });

    it('a paused one says so and offers Enable schedule', () => {
        const row = rowOf(renderToStaticMarkup(<ProcessesPanel processes={[paused]} workspaces={workspaces} onAction={() => {}} now={NOW} />), 'p2');
        expect(row).toContain('Paused — not firing');
        expect(row).toContain('Next run: Not scheduled');
        expect(row).toContain('Last run: Never run');
        expect(names(row)).toEqual(['Run now', 'More actions']);
    });

    it('a nudge shows whom it prompts and with what, and no command', () => {
        const row = rowOf(renderToStaticMarkup(<ProcessesPanel processes={[nudge]} workspaces={workspaces} onAction={() => {}} now={NOW} />), 'p3');
        expect(row).toContain('Each run nudges atlas@tynn with');
        expect(row).toContain('post the standup');
    });

    it('CONTROL: a process kept running is not scheduled — Stop, with Restart in the menu', () => {
        const row = rowOf(renderToStaticMarkup(<ProcessesPanel processes={[queue]} workspaces={workspaces} onAction={() => {}} now={NOW} />), 'p4');
        expect(row).not.toContain('scheduled');
        expect(names(row)).toEqual(['Stop', 'More actions']);
    });

    it('its buttons send Run now, Pause / Enable schedule', () => {
        const sent: FeatureAction[] = [];
        const walk = (n: unknown): void => {
            if (n === null || typeof n !== 'object') return;
            if (Array.isArray(n)) { n.forEach(walk); return; }
            const el = n as { type?: unknown; props?: Record<string, unknown> };
            // The icon button is Run now; the menu holds Pause / Enable (Remove is not pressed here).
            if (el.type === RowIconButton) (el.props!.onRun as (a: unknown) => void)(el.props!.action);
            if (el.type === RowMenu) for (const item of el.props!.items as { id: string }[]) if (item.id === 'pause' || item.id === 'enable') (el.props!.onRun as (a: unknown) => void)(item);
            walk(el.props?.children);
        };
        walk(ProcessesPanel({ processes: [nightly, paused], workspaces, onAction: (a) => { sent.push(a); }, now: NOW }));
        expect(sent).toEqual([
            { kind: 'hosting.runScheduledNow', processId: 'p1' },
            { kind: 'hosting.pauseSchedule', processId: 'p1' },
            { kind: 'hosting.runScheduledNow', processId: 'p2' },
            { kind: 'hosting.enableSchedule', processId: 'p2' },
        ]);
    });

    it('the add form offers a schedule, from Genie 1’s presets — none by default', () => {
        const html = renderToStaticMarkup(<AddProcessForm workspaces={workspaces} onSubmit={() => {}} onCancel={() => {}} />);
        expect(html).toMatch(/<select[^>]*name="schedule"/);
        for (const label of ['No schedule (run as a service)', 'Every 5 minutes', 'Hourly, on the hour', 'Daily at 03:00', 'Weekdays at 09:00', 'Monthly, the 1st at 03:00']) expect(html).toContain(label);
    });
});
