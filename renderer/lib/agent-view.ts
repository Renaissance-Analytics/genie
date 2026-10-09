import { sessionFidelity, type AgentSession, type PendingApproval } from '../../main/agentsession/model';
import type { AgentTab } from './view-route';

/**
 * The Agent view's SHAPE — Genie 2's most important screen.
 *
 * Kept pure because the renderer's test environment has no DOM: a decision made inside a
 * component is a decision nobody checks.
 *
 * ## Absence of a tab, not a disabled tab
 *
 * A **Declared** agent speaks a structured transport and can show a Conversation. An
 * **Observed** one — every pty provider — cannot, because Genie only sees bytes
 * (`main/terminal/submit.ts`: *"Genie cannot see inside a TUI; it sees bytes"*). So the
 * Observed shape leads with Terminal and offers **Activity** instead.
 *
 * Nothing is greyed out. *A disabled control is an accusation; a different shape is a
 * fact.* A greyed-out "Conversation" tells someone they did something wrong, when the truth
 * is that their provider does not report one. This is the same discipline
 * `renderer/lib/provider-brand.ts` already applies to logos.
 *
 * The RAILS are not decided here: `knownFacts` in the session model already owns the
 * `null` ⇒ cannot see / `[]` ⇒ none rule, and a second copy of it would be a second thing
 * to get wrong.
 */

/**
 * The route's own tab vocabulary, reused rather than redefined.
 *
 * `view-route.ts` already names these, and a second list would be a second truth that could
 * disagree with the URL. Note the key is `session` while the LABEL is "Conversation" -- the
 * route names the thing, the UI names what a person calls it.
 */
export type AgentViewTab = AgentTab;

/**
 * Which tabs this agent gets.
 *
 * **There is no `terminal` tab in any shape.** Owner's ruling, 2026-10-08: *"The new UX
 * needs the ability to open an agent in a provider TUI but that opens in a new window, not
 * in theFloor. the only terminal like ux in the floor is when watching an agents workstream
 * (firehose layout) which isn't a real terminal."*
 *
 * So a pty never mounts inside the Floor. Reaching one is `terminals.openWindow({ kind:
 * 'agent' })` (Tynn #447), offered as an ACTION in the header — a verb, and a transfer of
 * control, where a tab would be a place.
 *
 * What replaces it is not a loss of information but a change of source: a Declared agent's
 * Stream and an Observed agent's Activity are both rendered from what was reported, where
 * an embedded xterm re-showed bytes Genie had already failed to understand.
 */
export function agentViewTabs(s: AgentSession): readonly AgentViewTab[] {
    if (sessionFidelity(s) === 'declared') {
        return ['session', 'files', 'changes'];
    }
    // Observed and unknown. `activity` is a SPARKLINE — a measurement, offered precisely
    // because there are no declared facts. A Declared agent never gets it: presenting a
    // guess beside the truth would imply they are peers. It leads here because it is the
    // only thing this agent can honestly show first.
    return ['activity', 'files', 'changes'];
}

/** What opens. The first tab of the shape, which is the point of ordering them. */
export function defaultTabFor(s: AgentSession): AgentViewTab {
    return agentViewTabs(s)[0]!;
}

/**
 * The approval the turn is parked behind, if there is one.
 *
 * Both halves must agree: the turn says `awaiting-approval` **and** an approval actually
 * arrived. If the state claims parked but nothing is pending, this returns null rather than
 * rendering a banner with nothing to click — a user stuck in front of an empty prompt is
 * worse off than one reading the transcript.
 */
export function parkedApproval(s: AgentSession): PendingApproval | null {
    if (s.turn.state !== 'awaiting-approval') return null;
    return s.approvals[0] ?? null;
}
