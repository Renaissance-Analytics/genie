/**
 * "When something happens" — the one trigger kind fancy-flow has no equivalent
 * for.
 *
 * The package ships `manual_trigger`, `schedule_trigger` and `webhook_trigger`,
 * and those three DECLARE a trigger: nothing in fancy-flow observes a host,
 * because a workflow engine cannot know what a host is. Genie's machine emits
 * things — a file lands in a workspace, an agent finishes, a process exits — and
 * a flow that cannot react to them is a flow that can only run on a timer.
 *
 * So this is Genie's own trigger kind, and its whole content is a choice of
 * event.
 *
 * ## The options come from the live registry
 *
 * The owner's constraint for #270, verbatim:
 *
 *   > this list will need to be able to expand without a huge system overhaul.
 *
 * A trigger system that needs an engine change to learn a new event ossifies.
 * So the node's `event` field is built FROM `FlowEventRegistry` rather than from
 * a literal, and the only thing adding an event kind requires is adding a
 * registry entry — which `__tests__/event-triggers.test.ts` holds down from both
 * ends: it selects on an event Genie has never heard of, and it asserts nothing
 * in the selection path names an event id at all.
 *
 * Registering again REPLACES, because the options are data that changes: a
 * producer that registers its event after boot has to be able to make it
 * selectable, and a kind that quietly kept the old list would be a menu missing
 * the entry somebody just added.
 *
 * ## There is no filter here
 *
 * The system this replaces had twelve operators, three grouping modes and a
 * form to build them in. All of that is a `branch` node now — on the canvas,
 * where the author can see the condition and where a run shows which way it
 * went. A filter language that only exists inside a trigger is a second, worse
 * conditional that nothing else in the graph can use.
 */

import { registerNodeKind } from '@particle-academy/fancy-flow/engine';
import type { FlowEventRegistry } from './events';

/** The canonical kind id. Genie's namespace, like every other Genie step. */
export const GENIE_EVENT_TRIGGER_KIND = '@genie/event_trigger';

/**
 * The one live registration, so re-registering can replace rather than throw.
 *
 * A module-level handle rather than a returned unsubscribe, because there is
 * exactly one writer of this kind and handing the undo to callers would create
 * a second thing that has to agree about which definition is current.
 */
let undo: (() => void) | null = null;

/** Put the event trigger in this process's registry, with today's event list. */
export function registerEventTriggerKind(registry: FlowEventRegistry): void {
    undo?.();

    const events = registry.list();
    undo = registerNodeKind({
        name: GENIE_EVENT_TRIGGER_KIND,
        category: 'trigger',
        label: 'When something happens',
        description: 'Runs this flow when Genie reports the event you choose.',
        configSchema: [
            {
                key: 'event',
                type: 'select',
                label: 'Event',
                description:
                    events.length > 0
                        ? 'Which of Genie’s events starts this flow.'
                        : 'Genie is not reporting any events yet, so this trigger cannot fire.',
                options: events.map((e) => ({ value: e.id, label: e.label })),
            },
        ],
        outputs: [{ id: 'out' }],
    } as never);
}

/** Remove the kind. For a process that is tearing the flow system down. */
export function clearEventTriggerKind(): void {
    undo?.();
    undo = null;
}
