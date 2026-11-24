import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { flowDocument } from '../src/core/flow-form.js';
import type { FlowRecord } from '../src/main/flow-store.js';
import { FlowRow } from '../src/renderer/components/FeatureSurfaces.js';

/**
 * A FLOW OF A WORKSPACE NOT TRUSTED SAYS SO ON ITS ROW (Tynn #364). The host's list carries why it is held (`held`); the
 * Flows tab shows it beside the flow, so an armed flow that does not fire is not a mystery.
 */

const flow = (over: Partial<FlowRecord> & { held?: string } = {}) => ({
    id: 'flow_a', workspaceId: 'tynn', name: 'nightly report',
    document: flowDocument({ workspaceId: 'tynn', cron: '0 3 * * *', step: { kind: 'command', command: 'npm run report', folder: '' } }),
    armed: true, createdBy: { kind: 'user' as const }, createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z', refusals: [], runs: [],
    ...over,
});
const row = (f: ReturnType<typeof flow>) => renderToStaticMarkup(FlowRow({ flow: f as never, workspaces: [{ id: 'tynn', path: '/w/tynn' }], now: Date.UTC(2026, 9, 26), confirming: null, onAction: () => {}, onAsk: () => {} }));

describe('a flow row', () => {
    it('held: says why, on the row', () => {
        const html = row(flow({ held: 'held: workspace not trusted' }));
        expect(html).toContain('data-flow-held');
        expect(html).toContain('held: workspace not trusted');
    });
    it('CONTROL: not held, nothing is said', () => {
        expect(row(flow())).not.toContain('data-flow-held');
    });
});
