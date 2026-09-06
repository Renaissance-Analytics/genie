import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFlowEventRegistry } from '../events';
import { GENIE_EVENT_TRIGGER_KIND, registerEventTriggerKind } from '../event-trigger';
import { getNodeKind } from '@particle-academy/fancy-flow/engine';
import { selectFlowsForEvent } from '../select';
import { eventTriggersFor } from '../triggers';
import type { FlowRow } from '../store';

/**
 * Adding an event kind must stay "add an entry to a list".
 *
 * The owner's constraint for #270, verbatim:
 *
 *   > this list will need to be able to expand without a huge system overhaul.
 *
 * A trigger system that needs an engine change to learn a new event ossifies,
 * and the feature calcifies with it. So this holds the property down from BOTH
 * ends, because either half alone can pass while the property is broken:
 *
 *   1. **Behaviourally** — an event Genie has never heard of, registered here
 *      and nowhere else, selects a flow and offers itself in the trigger node's
 *      menu.
 *   2. **Structurally** — the modules that read triggers and select flows name
 *      NO event id at all. A behavioural test alone would still pass if
 *      `files:added` were special-cased somewhere, as long as the new event
 *      happened to take the general path.
 *
 * The old version of this file drove `FlowRuntime`, the recipe engine that no
 * longer exists. The property outlived the engine, which is the point of writing
 * a test about a property rather than about a class.
 */

const FLOWS_DIR = path.join(__dirname, '..');

const WEATHER = {
    id: 'weather:changed',
    label: 'The weather changed',
    props: [{ key: 'workspaceId', type: 'string' as const, label: 'Workspace' }],
};

function flow(graph: unknown): FlowRow {
    return {
        id: 'f1',
        appId: null,
        title: 'Whatever',
        purpose: 'Automation',
        scope: { kind: 'system' },
        graph: graph as never,
        enabled: true,
        createdAt: 'x',
        updatedAt: 'x',
    };
}

const triggerNode = (event: string) => ({
    id: 'e',
    type: GENIE_EVENT_TRIGGER_KIND,
    position: { x: 0, y: 0 },
    data: { kind: GENIE_EVENT_TRIGGER_KIND, label: 'When', config: { event } },
});

describe('an event Genie has never heard of', () => {
    it('is selectable in the trigger node the moment it is registered', () => {
        const registry = createFlowEventRegistry([]);
        registry.register(WEATHER);
        registerEventTriggerKind(registry);

        const field = getNodeKind(GENIE_EVENT_TRIGGER_KIND)?.configSchema?.find(
            (f) => f.key === 'event',
        );
        expect(
            (field as { options?: { value: string }[] })?.options?.map((o) => o.value),
        ).toEqual(['weather:changed']);
    });

    it('is read off a graph like any other', () => {
        const graph = { nodes: [triggerNode('weather:changed')], edges: [] };

        expect(eventTriggersFor(graph, 'weather:changed').map((t) => t.nodeId)).toEqual(['e']);
    });

    it('runs a flow that listens for it', () => {
        const graph = { nodes: [triggerNode('weather:changed')], edges: [] };

        expect(
            selectFlowsForEvent([flow(graph)], {
                event: 'weather:changed',
                props: {},
                source: { kind: 'system' },
            }),
        ).toEqual([{ flowId: 'f1', nodeIds: ['e'] }]);
    });
});

describe('nothing on the path names an event', () => {
    /**
     * The structural half.
     *
     * A producer OWNS its event id — `file-source.ts` declares `files:added` and
     * is also the code that emits it, which is what keeps the declaration and
     * the emitter from drifting. What must contain no event id is everything
     * between: the modules that decide which flows an event reaches and which
     * of their nodes fired.
     */
    it.each([['select.ts'], ['triggers.ts'], ['event-trigger.ts'], ['runner.ts']])(
        '%s mentions no event id',
        (file) => {
            const source = fs.readFileSync(path.join(FLOWS_DIR, file), 'utf8');
            // Strip comments: the docblocks legitimately give `files:added` as an
            // example, and a guard that reads prose as code is a guard that
            // fails for the wrong reason. Line comments first, then blocks.
            const code = source
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .split('\n')
                .map((line) => line.replace(/\/\/.*$/, ''))
                .join('\n');

            // `<domain>:<event>` in a string literal — the shape every event id
            // has, so a new one is caught as surely as the ones that exist.
            const literals = code.match(/['"`][a-z][a-z0-9.-]*:[a-z][a-z0-9-]*['"`]/g) ?? [];
            expect(literals, `${file} names an event id`).toEqual([]);
        },
    );

    it('would notice one — the guard is not vacuous', () => {
        // A positive control. "No matches" passes just as well on a regex that
        // matches nothing at all, which is how a source guard rots silently.
        const sample = `const x = 'files:added';`;
        expect(sample.match(/['"`][a-z][a-z0-9.-]*:[a-z][a-z0-9-]*['"`]/g)).toEqual([
            `'files:added'`,
        ]);
    });
});
