import { afterEach, describe, expect, it } from 'vitest';
import { getNodeKind, listNodeKinds } from '@particle-academy/fancy-flow/engine';
// `buildNodeTypes` lives on `/registry` — it maps kind ids to React renderers,
// so it is not part of the React-free engine surface. Imported here because it
// is what the CANVAS uses, and "is it in the registry" is a weaker question
// than "will the canvas draw it as a Fancy node".
import { buildNodeTypes } from '@particle-academy/fancy-flow/registry';
import { paletteKindFilter, registerFlowKinds, type FlowNodeDefinitionView } from '../flow-kinds';
import { PAUSES_WITHOUT_RESUME } from '../../../main/flows/pauses';

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
 * fancy-flow's three human-pause kinds park a run by aborting with a structured
 * token that a host resumes from by replaying with `resumeOutputs`. Genie
 * decodes the token and does not yet resume, so a flow containing one can be
 * drawn, armed, and then hang for good with nothing saying why.
 *
 * Until 0.66.0 there was nothing to be done about it here: `<FlowEditor>`
 * narrowed its palette by CATEGORY and not by kind, so a host could not offer a
 * subset, and the only workaround was re-categorising Genie's own nodes until a
 * category filter happened to exclude fancy's — distorting the taxonomy to hide
 * a gap. That was filed upstream instead, and 0.66.0 answers it with
 * `kindFilter`.
 *
 * So the trap is now closed at the palette. **The refusals stay**, and these
 * tests are not their replacement: a filter is presentation and cannot see a
 * graph that arrives by another door — hand-authored, imported, or written by an
 * agent through `manageFlows`. See `main/flows/__tests__/authority.test.ts` and
 * `mcp.test.ts` for the doors themselves.
 */
describe('the palette hides the steps Genie cannot resume', () => {
    it.each([...PAUSES_WITHOUT_RESUME])('hides %s', (name) => {
        const kind = getNodeKind(name);
        // A positive control on the INPUT. "The filter hides it" passes just as
        // well against a kind that is not registered at all, so a rename
        // upstream has to fail HERE — where it means "the list is stale" —
        // rather than silently downgrading every assertion below to a tautology.
        expect(kind, `${name} is not a registered kind any more`).not.toBeNull();
        expect(paletteKindFilter({ kind: kind! })).toBe(false);
    });

    it('keeps the logic steps sitting beside them', () => {
        // Without this, a filter that hid EVERYTHING would pass the above.
        for (const name of [
            '@particle-academy/branch',
            '@particle-academy/merge',
            '@particle-academy/output',
        ]) {
            expect(paletteKindFilter({ kind: getNodeKind(name)! })).toBe(true);
        }
    });

    it('keeps Genie’s own steps', () => {
        register([def('@genie/testPalette')]);

        expect(paletteKindFilter({ kind: getNodeKind('@genie/testPalette')! })).toBe(true);
    });

    it('hides EXACTLY what the refusals refuse, over the whole real registry', () => {
        // The point of the test, and the reason it sweeps the registry rather
        // than naming three kinds: the palette and the refusals must be driven
        // by ONE list. Add a fourth pause kind to `PAUSES_WITHOUT_RESUME` and
        // the palette hides it with no second edit; write a second list here and
        // the two drift, which is exactly how two disagreeing copies of
        // `HOST_SOURCED_SETTINGS_KEYS` shipped in this repo.
        //
        // `k` is annotated because the ROOT tsconfig resolves with
        // `moduleResolution: "node"` and cannot read this package's `exports`
        // map, so `listNodeKinds()` degrades to `any` there and the callbacks
        // become implicit-any errors. The renderer's own lane infers it fine;
        // this just keeps the root lane's count honest.
        const hidden = listNodeKinds()
            .filter((k: { name: string }) => !paletteKindFilter({ kind: k }))
            .map((k: { name: string }) => k.name)
            .sort();

        expect(hidden).toEqual([...PAUSES_WITHOUT_RESUME].sort());
    });
});
