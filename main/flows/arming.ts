import type { FlowAdmission, FlowNodeRefusal } from './admission';

/**
 * PURE. Whether a flow may be ARMED, and what to say when it may not.
 *
 * ## Why arming needed its own check
 *
 * Every other moment already had one. The editor calls `flows:check` as the
 * author works and shows refusals on the canvas; `save` returns them to an agent.
 * `flows:set-enabled` checked nothing, so a flow holding a step Genie refuses
 * could be switched on, put on a schedule, and fail every thirty minutes forever
 * — with the run list showing a truncated reason and no statement of what to
 * change.
 *
 * Arming is the moment that matters, because it is where a draft stops being a
 * draft and starts spending somebody's attention unattended. A refusal on the
 * canvas is advice; a refusal here is the difference between a flow that works
 * and a recurring alarm nobody can silence without deleting it.
 *
 * ## What it does NOT do
 *
 * It does not refuse DISARMING. Turning a flow off must always work — a flow
 * that cannot be armed is exactly the flow somebody most needs to turn off, and
 * a guard that blocked both would trap a failing flow in the armed state. The
 * caller applies this only when switching on.
 *
 * It also states no advice of its own. The reason each refusal carries already
 * names the step to use instead (`refusals.ts`), and restating it here would put
 * the same guidance in two places to drift apart.
 */
export interface ArmingRefusal {
    /** One message, naming the flow and every step that cannot run. */
    error: string;
    /** The per-node detail, so a UI can point at the steps rather than parse prose. */
    refusals: FlowNodeRefusal[];
}

/** How a refused step is named to someone reading a list of flows later. */
function nameOf(refusal: FlowNodeRefusal): string {
    return refusal.label && refusal.label.trim() !== '' ? refusal.label : refusal.nodeId;
}

/**
 * Null when this flow may be armed, or the refusal to show when it may not.
 *
 * `title` is included because a scheduled flow's failure is read out of context —
 * from a list, by someone who was not looking at the canvas when they armed it.
 */
export function armingRefusal(admission: FlowAdmission, title: string): ArmingRefusal | null {
    if (admission.allowed) return null;

    // A graph-wide refusal names no node — an empty graph, or a scope with no
    // authority. Reading only `refusals` would arm those silently, which is the
    // failure this whole module exists to prevent.
    if (admission.refusals.length === 0) {
        return {
            error:
                `“${title}” cannot be turned on: ${admission.reason ?? 'Genie will not run this flow.'}`,
            refusals: [],
        };
    }

    // EVERY refused step, not the first. Being told about one, fixing it, and
    // being told about the next — one arming at a time — is the shape that makes
    // people stop reading the message.
    const detail = admission.refusals
        .map((refusal) => `• ${nameOf(refusal)}: ${refusal.reason}`)
        .join('\n');

    const count = admission.refusals.length;
    return {
        error:
            `“${title}” cannot be turned on — ${count} step${count === 1 ? '' : 's'} ` +
            `Genie will not run:\n${detail}`,
        refusals: admission.refusals,
    };
}
