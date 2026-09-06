import { afterEach, describe, expect, it } from 'vitest';
import { getNodeKind, listNodeKinds } from '@particle-academy/fancy-flow/engine';
// `buildNodeTypes` lives on `/registry` — it maps kind ids to React renderers,
// so it is not part of the React-free engine surface. Imported here because it
// is what the CANVAS uses, and "is it in the registry" is a weaker question
// than "will the canvas draw it as a Fancy node".
import { buildNodeTypes } from '@particle-academy/fancy-flow/registry';
import { paletteKindFilter, registerFlowKinds, type FlowNodeDefinitionView } from '../flow-kinds';
import { PAUSES_WITHOUT_RESUME, refusalFor } from '../../../main/flows/refusals';

/**
 * Putting Genie's steps on the canvas.
 *
 * fancy-flow's node registry is per-PROCESS, and `<FlowEditor>` reads the
 * renderer's. Main registering Genie's kinds does nothing for the palette a
 * person sees, which is why the canvas offered only fancy's 27 builtins — every
 * one of which Genie's executor refuses — while the steps Genie can actually run
 * existed only in the main process and in an IPC handler nobody called.
 *
 * So the renderer registers too, from the definitions main sends. These tests
 * pin the three things that must hold for that to be safe:
 *
 *   1. what is registered is what the app was GRANTED — the registered set is
 *      the palette, because fancy-flow can narrow a palette by category but not
 *      by kind, and a GApp window is its own renderer process;
 *   2. registering twice does not throw, because a panel remounts;
 *   3. unregistering actually removes, so a window that switches app cannot keep
 *      offering the previous one's steps.
 */

const def = (name: string): FlowNodeDefinitionView => ({
    name,
    aliases: [`${name.replace('@genie/', 'genie.')}`],
    tool: name.replace('@genie/', ''),
    capability: 'terminals',
    category: 'io',
    label: 'A step',
    description: 'Does a thing.',
    configSchema: [{ key: 'action', label: 'Action', type: 'text' }],
    inputs: [{ id: 'in' }],
    outputs: [{ id: 'out' }],
    sideEffects: 'unsafe-to-replay',
});

const cleanups: (() => void)[] = [];

afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
});

function register(defs: FlowNodeDefinitionView[]) {
    const undo = registerFlowKinds(defs);
    cleanups.push(undo);
    return undo;
}

describe('registering the palette a window may author with', () => {
    it('puts each definition in the registry the editor reads', () => {
        register([def('@genie/testAlpha')]);

        expect(getNodeKind('@genie/testAlpha')?.label).toBe('A step');
        // `buildNodeTypes` is what the canvas uses to pick a renderer. A kind
        // absent from it draws as a default React Flow box, not a Fancy node.
        expect(Object.keys(buildNodeTypes())).toContain('@genie/testAlpha');
    });

    it('registers the legacy alias too, so an older graph still resolves', () => {
        register([def('@genie/testBeta')]);

        expect(getNodeKind('genie.testBeta')?.name).toBe('@genie/testBeta');
    });

    it('survives a remount without throwing', () => {
        // `registerNodeKind` throws on a duplicate, and a React panel remounts
        // for reasons that have nothing to do with flows.
        register([def('@genie/testGamma')]);
        expect(() => register([def('@genie/testGamma')])).not.toThrow();
        expect(getNodeKind('@genie/testGamma')).not.toBeNull();
    });

    it('removes what it added when the panel goes away', () => {
        const before = listNodeKinds().length;
        const undo = registerFlowKinds([def('@genie/testDelta')]);

        expect(getNodeKind('@genie/testDelta')).not.toBeNull();
        undo();

        // Not merely "count went back": a window that switched app and kept the
        // old kinds would offer steps the new app was never granted.
        expect(getNodeKind('@genie/testDelta')).toBeNull();
        expect(listNodeKinds().length).toBe(before);
    });

    it('never touches a builtin it did not register', () => {
        const undo = registerFlowKinds([def('@genie/testEpsilon')]);
        undo();

        expect(getNodeKind('@particle-academy/branch')).not.toBeNull();
    });

    it('registers nothing at all for an app that holds nothing', () => {
        const before = listNodeKinds().length;
        register([]);
        expect(listNodeKinds().length).toBe(before);
    });
});

/**
 * What the palette does NOT offer.
 *
 * Genie refuses EIGHTEEN of fancy-flow's kinds, for three different families of
 * reason, and every one of them used to sit in the palette waiting to be dragged
 * onto a canvas and then refused:
 *
 *   - three PAUSE a run Genie cannot resume (`human_approval`, `user_input`,
 *     `rich_user_input`) — the worst, because the flow hangs rather than fails;
 *   - twelve reach something Genie will not give a flow (`api_request`,
 *     `llm_call`, `subflow`, `memory_store`, `for_each`, `webhook_trigger`, …);
 *   - three drive a terminal Genie has not wired for flows.
 *
 * The first fix here hid only the three pause kinds, which was the brief and was
 * wrong: SubFlow, For Each, Memory Store and Webhook were still on the canvas
 * where anyone could reach them.
 *
 * So the predicate is `refusalFor` — **the same function the executor calls at
 * the door**, not a list beside it. A kind added to `REFUSALS` or to
 * `PAUSES_WITHOUT_RESUME` is hidden and refused by that one edit. Two lists with
 * one consumer is fine; two lists with two independent consumers is how two
 * disagreeing copies of `HOST_SOURCED_SETTINGS_KEYS` shipped in this repo.
 *
 * **The refusals stay.** These tests are not their replacement: a filter is
 * presentation and only ever sees the palette. A graph that arrives
 * hand-authored, imported, or written by an agent through `manageFlows` never
 * passes through here. See `main/flows/__tests__/authority.test.ts`, `mcp.test.ts`
 * and `runner.test.ts` for the doors themselves.
 */
describe('the palette offers only steps Genie can actually run', () => {
    /** Every registered kind, as the palette sees them. */
    const registered = () => listNodeKinds() as { name: string }[];

    it('hides EXACTLY what the door refuses — derived from the tables, not listed', () => {
        // Written as a comparison of two derived sets on purpose. A hand-written
        // list of eighteen strings would rot the moment somebody adds a
        // nineteenth refusal, and would rot SILENTLY — still green, with a new
        // trap on the canvas.
        const refused = registered()
            .filter((k) => refusalFor(k.name) !== null)
            .map((k) => k.name)
            .sort();
        const hidden = registered()
            .filter((k) => !paletteKindFilter({ kind: k }))
            .map((k) => k.name)
            .sort();

        expect(hidden).toEqual(refused);
        // Guards the test itself: if `refusalFor` ever returned null for
        // everything, both sides would be `[]` and this would pass while the
        // palette offered the lot.
        expect(refused.length).toBeGreaterThan(PAUSES_WITHOUT_RESUME.size);
    });

    it.each([...PAUSES_WITHOUT_RESUME])('hides %s, which would HANG a run', (name) => {
        const kind = getNodeKind(name);
        // A positive control on the INPUT. "The filter hides it" passes just as
        // well against a kind that is not registered at all, so a rename
        // upstream has to fail HERE — where it means "the list is stale" —
        // rather than silently downgrading the assertion to a tautology.
        expect(kind, `${name} is not a registered kind any more`).not.toBeNull();
        expect(paletteKindFilter({ kind: kind! })).toBe(false);
    });

    it.each([
        'subflow',
        'for_each',
        'memory_store',
        'webhook_trigger',
        'api_request',
        'llm_call',
        'notify',
        'terminal_run',
    ])('hides %s, which would FAIL a run', (bare) => {
        // The four at the top are the ones visible in the owner's screenshot of
        // the broken palette. Named explicitly, as a regression pin, even though
        // the sweep above already covers them: this is the report, and a test
        // that names the reported symptom is the one somebody trusts.
        const kind = getNodeKind(`@particle-academy/${bare}`);

        expect(kind, `${bare} is not a registered kind any more`).not.toBeNull();
        expect(paletteKindFilter({ kind: kind! })).toBe(false);
    });

    it('CONTROL: keeps every logic step Genie implements', () => {
        // Without this, a filter that hid EVERYTHING would pass all of the
        // above — and an empty palette is exactly what a filter bug produces.
        for (const bare of [
            'branch',
            'merge',
            'transform',
            'switch_case',
            'variable',
            'wait',
            'log',
            'output',
            'manual_trigger',
            'schedule_trigger',
        ]) {
            const kind = getNodeKind(`@particle-academy/${bare}`);
            expect(kind, `${bare} is not registered`).not.toBeNull();
            expect(paletteKindFilter({ kind: kind! }), `${bare} should be offered`).toBe(true);
        }
    });

    it('CONTROL: keeps Genie’s own steps', () => {
        // `refusalFor` strips the scope from `@genie/manageSite` before looking
        // in `REFUSALS`, so a Genie tool whose bare name collided with a refused
        // fancy kind would vanish from the palette. None do — Genie's are
        // camelCase and fancy's are snake_case — and this is what says so.
        register([def('@genie/testPalette')]);

        expect(paletteKindFilter({ kind: getNodeKind('@genie/testPalette')! })).toBe(true);
    });

    it('CONTROL: keeps the visual-only kinds, which never reach an executor', () => {
        // `note` and the lanes are `annotation`/`layout`; the engine skips those
        // categories before choosing an executor, so they cannot fail a run and
        // must not be hidden.
        for (const bare of ['note', 'lane', 'terminal_lane']) {
            const kind = getNodeKind(`@particle-academy/${bare}`);
            expect(kind, `${bare} is not registered`).not.toBeNull();
            expect(paletteKindFilter({ kind: kind! }), `${bare} should be offered`).toBe(true);
        }
    });
});
