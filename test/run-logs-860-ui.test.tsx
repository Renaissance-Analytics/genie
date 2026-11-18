import { Button, Modal } from '@particle-academy/react-fancy';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import type { FlowRecord, FlowRun } from '../src/main/flow-store.js';
import type { HostedProcess } from '../src/main/process-book.js';
import { FlowEditorWindow } from '../src/renderer/components/FlowEditorWindow.js';
import { FlowRow, ProcessLogView, ProcessesPanel } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureAction, type FeatureData } from '../src/renderer/features.js';
import { control } from './helpers/control-markup.js';

/**
 * THE LOG, ONE CLICK AWAY (Tynn #860). Every process row, running or stopped, and every scheduled task has a Log button
 * (react-fancy's Button) that opens its kept output — a scheduled task's with its run history: when each run started and
 * ended, how it ended, why it failed, and what a nudge sent. The last failure's reason is on the row itself. A flow's run
 * opens in its run review.
 */

const NOW = new Date(2026, 10, 18, 9, 0, 0).getTime();
const base = { workspaceId: 'moic-suite', pid: null, exitCode: null, restarts: 0, since: NOW, durable: true as const };
const failedRun = { at: NOW - 60_000, endedAt: NOW - 59_000, status: 'failed' as const, reason: 'stoic@moic-suite is not running: Genie has no session for it to take the nudge', sent: 'check the ticket queue' };
const watch: HostedProcess = { ...base, id: 'p1', name: 'stoic ticket watch', state: 'stopped', schedule: { cron: '*/10 * * * *', kind: 'agent-nudge', prompt: 'check the ticket queue', agent: 'stoic@moic-suite', enabled: true, nextRunAt: NOW + 540_000, lastRunAt: failedRun.at, lastRunStatus: 'failed', runs: [failedRun] } };
const stoppedByRestart: HostedProcess = { ...base, id: 'p2', name: 'worker', state: 'stopped', command: 'php artisan queue:work', reason: 'stopped by restart (restart: never); use Start to run it again' };
const running: HostedProcess = { ...base, id: 'p3', name: 'vite', state: 'running', command: 'npm run dev', log: { text: 'ready', lines: 1, dropped: 0 } };
const workspaces = [{ id: 'moic-suite', path: '/w/moic' }];

/** Every element in a rendered tree, function components called (hook-free ones, as ProcessesPanel's rows are). */
function elements(node: ReactNode): ReactElement[] {
    const out: ReactElement[] = [];
    const walk = (n: unknown): void => {
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if (!isValidElement(n)) return;
        out.push(n);
        const props = n.props as { children?: unknown };
        walk(props.children);
    };
    walk(node);
    return out;
}

describe('a Log button on every process (Tynn #860)', () => {
    const html = renderToStaticMarkup(<ProcessesPanel processes={[watch, stoppedByRestart, running]} workspaces={workspaces} onAction={() => {}} now={NOW} />);

    it.each(['p1', 'p2', 'p3'])('row %s has a react-fancy Log button: an icon named Log, last on the line (Tynn #708: icons over words)', (id) => {
        const log = control(html, `data-process-log-open="${id}"`);
        expect(log).not.toBeNull();
        expect(log!.fancy).toBe(true);
        expect(log!.open).toMatch(/aria-label="Log"/);
        expect(log!.text).toBe('');
        expect(log!.inner).toMatch(/<svg/);
        const row = html.slice(html.indexOf(`data-process="${id}"`), html.indexOf('</li>', html.indexOf(`data-process="${id}"`)));
        const labels = [...row.matchAll(/<button\b[^>]*>/g)].map((m) => /aria-label="([^"]*)"/.exec(m[0])?.[1] ?? '');
        expect(labels.at(-1)).toBe('Log');
    });

    it('pressing it opens that process\'s log', () => {
        const sent: FeatureAction[] = [];
        const tree = ProcessesPanel({ processes: [watch, stoppedByRestart, running], workspaces, onAction: (a) => { sent.push(a); }, now: NOW });
        for (const el of elements(tree)) {
            const p = el.props as Record<string, unknown>;
            if (el.type === Button && typeof p['data-process-log-open'] === 'string') (p.onClick as () => void)();
        }
        expect(sent).toEqual(['p1', 'p2', 'p3'].map((processId) => ({ kind: 'hosting.openProcessLog', processId })));
    });

    it('a failed scheduled run says WHY on the row', () => {
        const row = html.slice(html.indexOf('data-process="p1"'), html.indexOf('data-process="p2"'));
        expect(row).toMatch(/data-run-reason/);
        expect(row).toContain('stoic@moic-suite is not running');
    });

    it('CONTROL: a run that went fine shows no reason', () => {
        const ok: HostedProcess = { ...watch, schedule: { ...watch.schedule!, lastRunStatus: 'ok', runs: [{ at: NOW - 1000, endedAt: NOW - 900, status: 'ok', sent: 'check the ticket queue' }] } };
        expect(renderToStaticMarkup(<ProcessesPanel processes={[ok]} workspaces={workspaces} onAction={() => {}} now={NOW} />)).not.toMatch(/data-run-reason/);
    });
});

describe('the log, opened (Tynn #860)', () => {
    it('opens in a Modal; Close closes it', () => {
        const sent: FeatureAction[] = [];
        const tree = ProcessesPanel({ processes: [watch], workspaces, onAction: (a) => { sent.push(a); }, now: NOW, processLog: { processId: 'p1', text: 'out', lines: 1, dropped: 0 } });
        const modal = elements(tree).find((e) => e.type === Modal);
        expect(modal).toBeDefined();
        expect((modal!.props as { open: boolean }).open).toBe(true);
        (modal!.props as { onClose: () => void }).onClose();
        expect(sent).toEqual([{ kind: 'hosting.closeProcessLog' }]);
    });

    it('a scheduled task\'s: each run with its outcome, start and end, the reason, and what it sent; then the output', () => {
        const html = renderToStaticMarkup(<ProcessLogView process={watch} log={{ processId: 'p1', text: 'process said this', lines: 1, dropped: 0 }} />);
        expect(html).toMatch(/data-scheduled-run="failed"/);
        expect(html).toContain('stoic@moic-suite is not running');
        expect(html).toContain('check the ticket queue');
        expect(html).toContain(new Date(failedRun.at).toLocaleString());
        expect(html).toContain('process said this');
    });

    it('a process with no output says so, and one Genie restarted says its earlier output was kept', () => {
        expect(renderToStaticMarkup(<ProcessLogView process={stoppedByRestart} log={{ processId: 'p2', text: '', lines: 0, dropped: 0 }} />)).toContain('No output');
        expect(renderToStaticMarkup(<ProcessLogView process={stoppedByRestart} log={{ processId: 'p2', text: 'x\n[genie] Genie restarted', lines: 2, dropped: 3 }} />)).toMatch(/3 earlier lines? (were|was) cut/);
    });
});

describe('a flow run opens in its run review (Tynn #860)', () => {
    const run: FlowRun = { at: '2026-11-18T03:00:00.000Z', endedAt: '2026-11-18T03:00:05.000Z', trigger: 'schedule', outcome: 'failed', reason: 'npm run report ended with exit code 2', nodes: { t: 'ran', s: 'failed' } };
    const n = (id: string, kind: string, config: Record<string, unknown> = {}) => ({ id, kind, position: { x: 0, y: 0 }, config });
    const flow: FlowRecord = {
        id: 'flow_a', workspaceId: 'moic-suite', name: 'nightly', armed: true,
        document: { $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes: [n('t', 'schedule_trigger', { cron: '0 3 * * *' }), n('s', 'genie/terminal_run', { workspace: 'moic-suite', command: 'npm run report' })], edges: [{ id: 'e1', source: 't', target: 's' }] } },
        createdBy: { kind: 'user' }, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', refusals: [], runs: [run, { ...run, at: '2026-11-18T04:00:00.000Z', outcome: 'ok', reason: undefined } as FlowRun],
    };

    it('each run in the Flows list has a Review button that opens THAT run', () => {
        const sent: FeatureAction[] = [];
        const tree = FlowRow({ flow: flow as never, workspaces, now: NOW, confirming: null, onAction: (a) => { sent.push(a); }, onAsk: () => {} });
        for (const el of elements(tree)) {
            const p = el.props as Record<string, unknown>;
            if (el.type === Button && typeof p['data-flow-review'] === 'string') (p.onClick as () => void)();
        }
        // Newest first, as the list shows them.
        expect(sent).toEqual([{ kind: 'flows.openEditor', flowId: 'flow_a', run: 1 }, { kind: 'flows.openEditor', flowId: 'flow_a', run: 0 }]);
    });

    it('the editor window opened on a run shows its review', () => {
        const data: FeatureData = { ...EMPTY_FEATURES, flows: { flows: [flow], adding: null } };
        const Viewer = () => <div data-stub-viewer="" />;
        const html = renderToStaticMarkup(<FlowEditorWindow flowId="flow_a" workspaceId={null} run={0} data={data} workspaces={workspaces} act={async () => data} Editor={() => <div />} Viewer={Viewer} now={NOW} />);
        expect(html).toContain('data-flow-run-overlay');
        expect(html).toContain('npm run report ended with exit code 2');
        // CONTROL: without a run it is the editor.
        expect(renderToStaticMarkup(<FlowEditorWindow flowId="flow_a" workspaceId={null} data={data} workspaces={workspaces} act={async () => data} Editor={() => <div data-stub-editor="" />} Viewer={Viewer} now={NOW} />)).not.toContain('data-flow-run-overlay');
    });
});
