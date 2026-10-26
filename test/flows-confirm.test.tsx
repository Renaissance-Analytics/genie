import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_URL, flowDocument } from '../src/core/flow-form.js';
import { flowReach } from '../src/core/flow-reach.js';
import type { FlowRecord } from '../src/main/flow-store.js';
import { FlowConfirm, FlowRow } from '../src/renderer/components/FeatureSurfaces.js';
import type { FeatureAction } from '../src/renderer/features.js';

/**
 * ARM AND DELETE ASK FIRST, AND ARM SAYS WHAT THE FLOW WILL DO (genie#1204; the owner, 2026-10-26: "i have no UX for
 * managing Flows at all"). Genie 1 confirmed before arming, naming what the flow could reach, and before deleting. Genie 2
 * armed and deleted on one click. Arming hands a flow to the clock: it then runs commands and prompts agents with nobody
 * watching, so the person sees exactly that — the schedule, its next run, each command and each agent — before it is armed.
 */

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const flow = (over: Partial<FlowRecord> = {}): FlowRecord => ({
    id: 'flow_a', workspaceId: 'tynn', name: 'nightly report',
    document: flowDocument({ workspaceId: 'tynn', cron: '0 3 * * *', step: { kind: 'command', command: 'npm run report', folder: '' } }),
    armed: false, createdBy: { kind: 'user' }, createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z', refusals: [], runs: [],
    ...over,
});

describe('what a flow will do once armed', () => {
    it('names its schedule with the next run, and every command and agent it reaches', () => {
        const reach = flowReach(flow().document, NOW);
        expect(reach.schedule).toEqual({ cron: '0 3 * * *', nextMs: expect.any(Number) });
        expect(reach.schedule!.nextMs).toBeGreaterThan(NOW);
        expect(reach.steps).toEqual(['runs the command `npm run report`']);
        const agent = flowReach(flowDocument({ workspaceId: 'tynn', cron: '*/5 * * * *', step: { kind: 'agent', agent: 'atlas@tynn', prompt: 'check the queue' } }), NOW);
        expect(agent.steps).toEqual(['prompts atlas@tynn']);
    });

    it('a flow with no schedule says it runs only when started by hand', () => {
        const reach = flowReach({ $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes: [], edges: [] } }, NOW);
        expect(reach.schedule).toBeNull();
    });
});

describe('the confirm', () => {
    const clicks = (node: unknown, label: string): void => {
        const walk = (n: unknown): void => {
            if (n === null || typeof n !== 'object') return;
            if (Array.isArray(n)) { n.forEach(walk); return; }
            const el = n as { type?: unknown; props?: Record<string, unknown> };
            if (el.type === 'button' && el.props?.children === label && typeof el.props.onClick === 'function') (el.props.onClick as () => void)();
            walk(el.props?.children);
        };
        walk(node);
    };

    it('Arm: says the schedule and what it runs; Arm sends flows.arm, Cancel sends nothing', () => {
        const sent: FeatureAction[] = [];
        let cancelled = 0;
        const props = { flow: flow(), kind: 'arm' as const, now: NOW, onAction: (a: FeatureAction) => { sent.push(a); }, onCancel: () => { cancelled += 1; } };
        const html = renderToStaticMarkup(<FlowConfirm {...props} />);
        expect(html).toContain('Arm “nightly report”?');
        expect(html).toContain('0 3 * * *');
        expect(html).toContain('runs the command `npm run report`');
        clicks(FlowConfirm(props), 'Cancel');
        expect(sent).toEqual([]);
        expect(cancelled).toBe(1);
        clicks(FlowConfirm(props), 'Arm');
        expect(sent).toEqual([{ kind: 'flows.arm', flowId: 'flow_a' }]);
    });

    it('Delete: says its runs go with it; Delete sends flows.remove', () => {
        const sent: FeatureAction[] = [];
        const props = { flow: flow(), kind: 'delete' as const, now: NOW, onAction: (a: FeatureAction) => { sent.push(a); }, onCancel: () => {} };
        expect(renderToStaticMarkup(<FlowConfirm {...props} />)).toContain('Delete “nightly report”?');
        clicks(FlowConfirm(props), 'Delete');
        expect(sent).toEqual([{ kind: 'flows.remove', flowId: 'flow_a' }]);
    });
});

describe('a flow row', () => {
    it('Run now acts at once; Arm and Delete only ASK (CONTROL: Disarm acts at once — it only stops the clock)', () => {
        const sent: FeatureAction[] = [];
        const asked: string[] = [];
        const press = (row: unknown) => {
            const walk = (n: unknown): void => {
                if (n === null || typeof n !== 'object') return;
                if (Array.isArray(n)) { n.forEach(walk); return; }
                const el = n as { type?: unknown; props?: Record<string, unknown> };
                if (el.type === 'button' && typeof el.props?.onClick === 'function') (el.props.onClick as () => void)();
                walk(el.props?.children);
            };
            walk(row);
        };
        const base = { workspaces: [], now: NOW, confirming: null, onAction: (a: FeatureAction) => { sent.push(a); }, onAsk: (k: 'arm' | 'delete' | null) => { asked.push(String(k)); } };
        press(FlowRow({ ...base, flow: flow() }));
        expect(sent).toEqual([{ kind: 'flows.runNow', flowId: 'flow_a' }]);
        expect(asked).toEqual(['arm', 'delete']);
        sent.length = 0;
        asked.length = 0;
        press(FlowRow({ ...base, flow: flow({ armed: true }) }));
        expect(sent).toEqual([{ kind: 'flows.runNow', flowId: 'flow_a' }, { kind: 'flows.disarm', flowId: 'flow_a' }]);
        expect(asked).toEqual(['delete']);
    });
});
