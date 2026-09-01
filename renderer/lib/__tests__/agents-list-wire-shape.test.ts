import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The `agents:list` payload MAIN sends and the shape the RENDERER expects are
 * the same shape.
 *
 * This is the test that was missing when v63 renamed the agent driver column,
 * and its absence broke every agent panel in every workspace on the owner's
 * machine the moment beta.294 auto-updated:
 *
 *     Cannot read properties of undefined (reading 'slice')
 *
 * `agentRecordsList` in main started emitting `tui`. `AgentRuntimeSpec` in the
 * renderer still declared `provider`. `AgentTuiSwitcher` read `fronted.provider`,
 * got `undefined`, and called `.slice(0, 1)` on it.
 *
 * BOTH TYPECHECKS PASSED AND ALL 6663 TESTS PASSED. Neither could see it: main
 * and the renderer each type this payload independently and nothing compares
 * them, so the wire between two internally-consistent halves is a blind spot.
 * Every renderer test built its own fixtures from the renderer's own type, so
 * they all agreed with each other and none of them agreed with main.
 *
 * A STRUCTURAL test, because that is the only kind that can cross the boundary
 * without booting Electron: it reads the literal keys main writes and the
 * literal fields the renderer declares, and requires them to match.
 */

const REPO = path.resolve(__dirname, '../../..');

/** The object literal `agentRecordsList` maps each runtime row into. */
function mainRuntimeKeys(): string[] {
    const src = fs.readFileSync(path.join(REPO, 'main', 'ipc.ts'), 'utf8');
    const start = src.indexOf('runtimes: agents.flatMap');
    expect(start, 'agentRecordsList runtimes mapping not found in main/ipc.ts').toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('}))', start));
    return [...block.matchAll(/^\s{16}([a-zA-Z]+):/gm)].map((m) => m[1]!);
}

/** The fields `AgentRuntimeSpec` declares in the renderer. */
function rendererRuntimeFields(): string[] {
    const src = fs.readFileSync(path.join(REPO, 'renderer', 'lib', 'ams-grid.ts'), 'utf8');
    const start = src.indexOf('export interface AgentRuntimeSpec');
    expect(start, 'AgentRuntimeSpec not found in renderer/lib/ams-grid.ts').toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('}', start));
    return [...block.matchAll(/^\s{4}([a-zA-Z]+)[?]?:/gm)].map((m) => m[1]!);
}

describe('agents:list — main and the renderer agree on the wire', () => {
    it('main sends `tui`, not `provider`', () => {
        const keys = mainRuntimeKeys();

        expect(keys).toContain('tui');
        expect(keys).not.toContain('provider');
    });

    it('the renderer declares `tui`, not `provider`', () => {
        const fields = rendererRuntimeFields();

        expect(fields).toContain('tui');
        expect(fields).not.toContain('provider');
    });

    it('every field the renderer requires is one main actually sends', () => {
        // The general form. A field the renderer declares and main never emits
        // arrives as `undefined`, and the first thing that touches it throws —
        // which is exactly what `.slice(0, 1)` did.
        const sent = new Set(mainRuntimeKeys());

        for (const field of rendererRuntimeFields()) {
            expect(sent, `renderer expects "${field}" but main never sends it`).toContain(field);
        }
    });

    it('POSITIVE CONTROL: both readers actually found something', () => {
        // A regex that silently matched nothing would make every assertion above
        // pass forever — the way a structural test rots into a no-op.
        expect(mainRuntimeKeys().length).toBeGreaterThan(3);
        expect(rendererRuntimeFields().length).toBeGreaterThan(3);
    });
});
