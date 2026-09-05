import { afterEach, describe, expect, it } from 'vitest';
import { getNodeKind, listNodeKinds } from '@particle-academy/fancy-flow/engine';
// `buildNodeTypes` lives on `/registry` — it maps kind ids to React renderers,
// so it is not part of the React-free engine surface. Imported here because it
// is what the CANVAS uses, and "is it in the registry" is a weaker question
// than "will the canvas draw it as a Fancy node".
import { buildNodeTypes } from '@particle-academy/fancy-flow/registry';
import { registerFlowKinds, type FlowNodeDefinitionView } from '../flow-kinds';

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
