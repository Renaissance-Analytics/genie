/**
 * The steps that would park a run Genie cannot resume — the ONE list.
 *
 * ## Why they are refused
 *
 * fancy-flow's human nodes pause by aborting with a structured token
 * (`fancy-flow:pause:{…}`), which the host is meant to decode, ask a person, and
 * then resume from by replaying the run with `resumeOutputs` — republishing every
 * node that already ran rather than running it again. Genie decodes the token.
 * **It does not yet resume.**
 *
 * So a flow containing one can be drawn, armed, and then hang forever, with
 * nothing anywhere saying the step it waits on can never complete. That is worse
 * than a missing feature: it looks like it works.
 *
 * `@genie/ForceTheQuestion` is deliberately NOT in here. It asks and returns
 * immediately; the answer arrives later through AgentInbox. It never parks a
 * run, so it is the one way a flow can involve a person today.
 *
 * ## Two consumers, and they are answering different questions
 *
 *  - **The palette hides them** — `renderer/lib/flow-kinds.ts` turns this list
 *    into `<FlowEditor>`'s `kindFilter`, so the node cannot be dragged on. That
 *    removes the TRAP.
 *  - **The doors refuse them** — admission (so the canvas says it while the
 *    author is still drawing), save, and run. That removes the SURPRISE, for a
 *    graph that already contains one: hand-authored, imported, or written by an
 *    agent through `manageFlows`.
 *
 * The second is not made redundant by the first. A filter is presentation and
 * only ever sees the palette; it cannot see a graph that arrives by another
 * door. Deleting the refusals because the palette hides the node would leave
 * two ends individually correct and the seam between them wrong.
 *
 * Until fancy-flow 0.66.0 the palette half was impossible: `<FlowEditor>`
 * narrowed by node CATEGORY and not by kind, so a host could not offer a subset,
 * and the only workaround — re-categorising Genie's own nodes until a category
 * filter happened to exclude fancy's — would have distorted the taxonomy to hide
 * a gap. That was filed upstream instead (fancy-flow #14), and `kindFilter` is
 * the answer.
 *
 * ## Why this is its own module
 *
 * It is a LEAF: no imports, and it must stay that way. The renderer reads it,
 * and `renderer/lib/__tests__/renderer-main-boundary.test.ts` allows a renderer
 * file to name a `main/` module only when that module pulls in nothing — because
 * TypeScript type-checks every file a program reaches, so one runtime import
 * here would drag main-process code into the renderer's compilation. Its sibling
 * `builtins.ts` imports the fancy-flow engine, which is precisely why the list
 * cannot live there any more.
 *
 * The alternative — a copy in the renderer — is the defect that shipped two
 * disagreeing versions of `HOST_SOURCED_SETTINGS_KEYS`. One list, two consumers.
 */
export const PAUSES_WITHOUT_RESUME: ReadonlySet<string> = new Set([
    '@particle-academy/human_approval',
    '@particle-academy/user_input',
    '@particle-academy/rich_user_input',
]);

/** The one sentence, shared by admission and the door so they cannot diverge. */
export const PAUSE_UNSUPPORTED =
    'it waits for a person, and Genie cannot resume a paused flow yet — so this step would stop the run for good rather than continuing after an answer. Ask with the “Force the question” step instead, which returns straight away.';
