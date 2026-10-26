import { describe, expect, it } from 'vitest';
import { FLOW_SCHEMA_URL, flowDocument, formEditable } from '../src/core/flow-form.js';
import { SCHEDULE_PRESETS, nextRunWords } from '../src/core/flow-schedule.js';

/**
 * A PERSON CAN EDIT A FLOW, AND PICK ITS SCHEDULE (genie#1204; the owner, 2026-10-26: "i have no UX for managing Flows at
 * all"). Genie 1 edited a flow on its canvas; Genie 2 let only an agent change one (MCP flows update). This step: the
 * Add-a-flow form opens on an EXISTING flow — but only a flow the form can say back exactly (one schedule, one step);
 * anything bigger is refused rather than flattened, so an agent's multi-step flow is never silently cut down. And the
 * schedule offers presets and says when it next runs, instead of a bare five-field cron.
 */

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);

describe('which flows the form can edit', () => {
    it('one schedule + one step (what the form makes) — yes', () => {
        expect(formEditable(flowDocument({ workspaceId: 'tynn', cron: '0 3 * * *', step: { kind: 'command', command: 'npm run report', folder: '' } }))).toBe(true);
        expect(formEditable(flowDocument({ workspaceId: 'tynn', cron: '0 3 * * *', step: { kind: 'log' } }))).toBe(true);
    });

    it('more than one step, or no schedule — no: the form would drop what it cannot show', () => {
        const two = { $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes: [
            { id: 't', kind: 'schedule_trigger', position: { x: 0, y: 0 }, config: { cron: '0 3 * * *' } },
            { id: 'a', kind: 'genie/terminal_run', position: { x: 1, y: 0 }, config: { workspace: 'tynn', command: 'a' } },
            { id: 'b', kind: 'genie/terminal_run', position: { x: 2, y: 0 }, config: { workspace: 'tynn', command: 'b' } },
        ], edges: [] } };
        expect(formEditable(two)).toBe(false);
        expect(formEditable({ $schema: FLOW_SCHEMA_URL, version: 1, graph: { nodes: [{ id: 'a', kind: 'genie/terminal_run', position: { x: 0, y: 0 }, config: { command: 'a' } }], edges: [] } })).toBe(false);
    });
});

describe('the schedule', () => {
    it('offers presets, each a valid five-field cron with words a person reads', () => {
        expect(SCHEDULE_PRESETS.length).toBeGreaterThanOrEqual(5);
        for (const p of SCHEDULE_PRESETS) {
            expect(p.cron.split(' ')).toHaveLength(5);
            expect(p.label.length).toBeGreaterThan(3);
            expect(nextRunWords(p.cron, NOW)).toMatch(/^Next run: /);
        }
    });

    it('says when it next runs; a cron it cannot read says so instead of a time', () => {
        expect(nextRunWords('0 3 * * *', NOW)).toMatch(/^Next run: /);
        expect(nextRunWords('nope', NOW)).toBe('Not a schedule Genie can read: five fields, e.g. 0 3 * * * (03:00 every day).');
        expect(nextRunWords('', NOW)).toBe('No schedule: it runs only when you start it.');
    });
});
