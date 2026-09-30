import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { armingRefusal } from '../arming';
import type { FlowAdmission } from '../admission';

/**
 * ARMING A FLOW THAT CANNOT RUN.
 *
 * `flows:set-enabled` armed anything. So a flow holding a step Genie refuses
 * could be switched on, put on a half-hourly schedule, and fail every thirty minutes
 * forever — which is exactly what it did: four runs, three different errors, and
 * nothing anywhere saying what to change.
 *
 * The editor already shows refusals on the canvas and `save` already returns them
 * to an agent. Neither is the moment that matters. ARMING is the moment a flow
 * stops being a draft and starts costing somebody attention on a schedule, and it
 * was the one place nothing checked.
 *
 * Disarming is deliberately never refused — see the test for it below.
 */
const clean: FlowAdmission = { allowed: true, capabilities: ['terminals'], refusals: [] };

const refused: FlowAdmission = {
    allowed: false,
    capabilities: [],
    refusals: [
        {
            nodeId: 'n1',
            label: 'Anything unreviewed?',
            reason: 'Genie has not wired a terminal for flows to drive yet, so this step has nothing to run in. Use the Manage Terminals step, which works in a real Genie terminal you can watch and take over.',
        },
    ],
};

describe('arming', () => {
    it('refuses to arm a flow whose steps Genie will not run', () => {
        const refusal = armingRefusal(refused, 'watch → Learning Review');

        expect(refusal).not.toBeNull();
        expect(refusal?.refusals).toHaveLength(1);
    });

    it('NAMES the flow and the step, because a schedule fires out of context', () => {
        // The message is read later, from a list of flows, by someone who was not
        // looking at the canvas. "A step cannot run" identifies nothing.
        const refusal = armingRefusal(refused, 'watch → Learning Review');

        expect(refusal?.error).toContain('watch → Learning Review');
        expect(refusal?.error).toContain('Anything unreviewed?');
    });

    it('carries the reason through verbatim, so the fix is in the refusal', () => {
        // The refusal text already says what to use instead. Summarising it here
        // would mean maintaining the advice in two places and letting them drift.
        const refusal = armingRefusal(refused, 'watch → Learning Review');

        expect(refusal?.error).toContain('Manage Terminals');
    });

    it('allows arming a flow with nothing refused', () => {
        // The positive control. A guard that refused everything would satisfy
        // every assertion above and break every flow in the app.
        expect(armingRefusal(clean, 'fine flow')).toBeNull();
    });

    it('reports a graph-wide refusal that names no node', () => {
        // `decideFlowAdmission` sets `reason` instead of `refusals` when nothing
        // single caused it — an empty graph, or no authority. Reading only
        // `refusals` would arm those silently.
        const graphWide: FlowAdmission = {
            allowed: false,
            capabilities: [],
            refusals: [],
            reason: 'An empty flow has nothing to run.',
        };

        const refusal = armingRefusal(graphWide, 'empty one');

        expect(refusal).not.toBeNull();
        expect(refusal?.error).toContain('An empty flow has nothing to run.');
    });

    it('lists EVERY refused step, not just the first', () => {
        // Fixing one and being told about the next, one arming at a time, is the
        // shape that makes people stop reading the message.
        const many: FlowAdmission = {
            allowed: false,
            capabilities: [],
            refusals: [
                { nodeId: 'a', label: 'Run in terminal', reason: 'first reason' },
                { nodeId: 'b', label: 'Type into terminal', reason: 'second reason' },
            ],
        };

        const refusal = armingRefusal(many, 'two problems');

        expect(refusal?.error).toContain('Run in terminal');
        expect(refusal?.error).toContain('Type into terminal');
        expect(refusal?.refusals).toHaveLength(2);
    });

    it('falls back to the node id when a step has no label', () => {
        const unlabelled: FlowAdmission = {
            allowed: false,
            capabilities: [],
            refusals: [{ nodeId: 'node-7', reason: 'because' }],
        };

        expect(armingRefusal(unlabelled, 'f')?.error).toContain('node-7');
    });
});

describe('the guard is actually wired', () => {
    // `armingRefusal` is pure and its tests pass whether or not anything calls
    // it. That is the defect shape this repo keeps finding — a capability built,
    // tested, and connected to nothing — and here it would be invisible: the
    // toggle would appear to work and the flow would still reach a schedule.
    const read = (p: string) => readFileSync(join(__dirname, '..', '..', '..', p), 'utf8');

    it('is called by the set-enabled handler AND its answer is returned', () => {
        // Both halves. An earlier version of this test asserted only that
        // `armingRefusal(` appeared in the file, and a mutation that computed the
        // refusal and then ignored it — `if (false) return …` — passed. Calling
        // the guard is not using it.
        const ipc = read('main/flows/ipc.ts');

        expect(ipc).toContain("import { armingRefusal } from './arming'");
        expect(ipc).toMatch(/if \(refusal\)\s*return \{ error: refusal\.error/);
    });

    it('guards ARMING only, so a broken flow can still be switched off', () => {
        // The property that keeps a failing flow from being trapped on.
        const ipc = read('main/flows/ipc.ts');
        const handler = ipc.slice(ipc.indexOf("ipcMain.handle('flows:set-enabled'"));
        const body = handler.slice(0, handler.indexOf('\n    });'));

        // The refusal is reached only under the arming branch.
        expect(body).toMatch(/if \(arming\)/);
        const guardAt = body.indexOf('armingRefusal(');
        const branchAt = body.indexOf('if (arming)');
        expect(branchAt).toBeGreaterThanOrEqual(0);
        expect(guardAt).toBeGreaterThan(branchAt);
    });

    it('surfaces the refusal in the flows UI instead of silently reverting', () => {
        // A refused arm that said nothing would look like a broken toggle: it
        // flips back on the refresh and the flow stays armable forever.
        const tab = read('renderer/components/Flows/FlowsTab.tsx');

        expect(tab).toMatch(/if \(result && 'error' in result\) setError\(result\.error\)/);
    });
});
