import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_URL } from '../src/core/flow-form.js';
import type { FlowRecord, FlowRun } from '../src/main/flow-store.js';
import { FlowsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureAction, type FeatureData } from '../src/renderer/features.js';

/**
 * THE FLOWS SURFACE (hosting ship line P4). A flow row offered only Arm / Disarm: no way to run one by hand, no
 * Delete although the action existed, and nothing about what its runs did. Now each row has Run now, Arm or
 * Disarm, and Delete; the last run's outcome and when; and under it the history — newest first, each run's
 * outcome (ran / failed / held back), whether the schedule or a Run now started it, and the reason it failed or
 * was held back.
 */

const flow = (over: Partial<FlowRecord>): FlowRecord => ({
    id: 'flow_a',
    workspaceId: 'tynn',
    name: 'nightly report',
    document: { $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes: [], edges: [] } },
    armed: false,
    createdBy: { kind: 'user' },
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
    refusals: [],
    runs: [],
    ...over,
});
const run = (over: Partial<FlowRun>): FlowRun => ({ at: '2026-10-15T03:00:00.000Z', endedAt: '2026-10-15T03:00:05.000Z', trigger: 'schedule', outcome: 'ran', ...over });
const data = (flows: FlowRecord[]): FeatureData => ({ ...EMPTY_FEATURES, flows: { flows, adding: null } });

function rowOf(html: string, id: string): string {
    const start = html.indexOf(`data-flow="${id}"`);
    expect(start).toBeGreaterThan(-1);
    // The row's own markup, up to the next row (or the list's end).
    const next = html.indexOf('data-flow="', start + 1);
    return html.slice(start, next === -1 ? undefined : next);
}
const buttonsOf = (row: string) => [...row.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]!);

describe('a flow row', () => {
    it('a disarmed flow offers Run now, Arm and Delete, and says it has not run yet', () => {
        const row = rowOf(renderToStaticMarkup(<FlowsSurface data={data([flow({})])} onAction={() => {}} onNavigate={() => {}} />), 'flow_a');
        expect(buttonsOf(row)).toEqual(['Run now', 'Arm', 'Delete']);
        expect(row).toMatch(/not run yet/);
        expect(row).not.toContain('data-flow-runs');
    });

    it('an armed flow offers Run now, Disarm and Delete', () => {
        const row = rowOf(renderToStaticMarkup(<FlowsSurface data={data([flow({ armed: true })])} onAction={() => {}} onNavigate={() => {}} />), 'flow_a');
        expect(buttonsOf(row)).toEqual(['Run now', 'Disarm', 'Delete']);
    });

    // Each button's action — and that Arm and Delete now ASK first (genie#1204) — is test/flows-confirm.test.tsx.

    it('shows the LAST run’s outcome, and the history newest first with each outcome, what started it, and why it failed or was held back', () => {
        const runs = [
            run({ at: '2026-10-13T03:00:00.000Z', outcome: 'ran' }),
            run({ at: '2026-10-14T03:00:00.000Z', outcome: 'failed', reason: 'npm run report ended with exit code 2' }),
            run({ at: '2026-10-15T09:12:00.000Z', trigger: 'manual', outcome: 'held', reason: 'atlas is busy (mid-turn); the prompt was not delivered' }),
        ];
        const row = rowOf(renderToStaticMarkup(<FlowsSurface data={data([flow({ armed: true, runs })])} onAction={() => {}} onNavigate={() => {}} />), 'flow_a');
        expect(row).toContain('data-flow-last="held"');
        expect(row).toMatch(/Runs · last 3/);
        const order = [...row.matchAll(/data-flow-run="(\w+)"/g)].map((m) => m[1]);
        expect(order).toEqual(['held', 'failed', 'ran']);
        expect(row).toContain('npm run report ended with exit code 2');
        expect(row).toContain('atlas is busy (mid-turn); the prompt was not delivered');
        expect(row).toMatch(/run now/);
        expect(row).toMatch(/on schedule/);
        expect(row).toMatch(/held back/);
        // The history does not change the row's actions.
        expect(buttonsOf(row)).toEqual(['Run now', 'Disarm', 'Delete']);
    });

    // Changed 2026-10-21 (the owner, 2026-10-21, of the GitHub card's "Carried over from Genie 1": "this is not needed … it should be the same"): no migration labels in the product. A flow brought over from Genie 1 reads exactly
    // like one made here.
    it('a flow brought over from Genie 1 looks like any other: no "from Genie 1" label (CONTROL: both rows drawn)', () => {
        const html = renderToStaticMarkup(<FlowsSurface data={data([flow({ id: 'flow_v1_s-report', importedFrom: { v1SpecId: 's-report' } }), flow({ id: 'flow_b' })])} onAction={() => {}} onNavigate={() => {}} />);
        expect(rowOf(html, 'flow_v1_s-report')).not.toMatch(/Genie 1/);
        expect(rowOf(html, 'flow_v1_s-report')).toContain('data-flow="flow_v1_s-report"');
        expect(rowOf(html, 'flow_b')).toContain('data-flow="flow_b"');
    });
});
