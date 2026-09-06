/**
 * Every step Genie will NOT run, and why — the one place that decides.
 *
 * Two tables and one function. `refusalFor` is called by BOTH consumers, which
 * is the point of the module:
 *
 *  - **the door** (`executors.ts`) refuses the step at run time, and admission,
 *    save and run report the sentence to whoever is looking;
 *  - **the palette** (`renderer/lib/flow-kinds.ts`) turns the same answer into
 *    `<FlowEditor>`'s `kindFilter`, so the step cannot be dragged on at all.
 *
 * The filter removes the TRAP; the refusals remove the SURPRISE, for a graph
 * that already contains one — hand-authored, imported, or written by an agent
 * through `manageFlows`. Neither makes the other redundant: a filter is
 * presentation and only ever sees the palette, so it never sees a graph that
 * arrived by another door.
 *
 * **They must be one function, not two lists.** An earlier pass filtered the
 * palette on `PAUSES_WITHOUT_RESUME` alone while the door refused everything in
 * `REFUSALS` too, and the difference was visible on the canvas: SubFlow, For
 * Each, Memory Store and Webhook sat there waiting to be dragged on and then
 * turned away. Two lists with one consumer is fine; two lists with two
 * independent consumers is how two disagreeing copies of
 * `HOST_SOURCED_SETTINGS_KEYS` shipped in this repo.
 *
 * ## The two families
 *
 * `PAUSES_WITHOUT_RESUME` — fancy-flow's human nodes pause by aborting with a
 * structured token (`fancy-flow:pause:{…}`) that a host resumes from by
 * replaying the run with `resumeOutputs`. Genie decodes the token. **It does not
 * yet resume.** So one of these does not fail a flow, it HANGS it, forever, with
 * nothing saying why — worse than a missing feature, because it looks like it
 * works.
 *
 * `REFUSALS` — everything else, each with a sentence in the author's own terms.
 * Data rather than a switch, so adding a kind means adding a reason; a kind with
 * no sentence falls through to the door's generic catch-all rather than being
 * admitted by omission. `executors.test.ts` fails the build if any registered
 * kind lands there, which is how the next upstream addition gets noticed.
 *
 * `@genie/ForceTheQuestion` is deliberately in NEITHER. It asks and returns
 * immediately; the answer arrives later through AgentInbox. It never parks a
 * run, so it is the one way a flow can involve a person today.
 *
 * ## Why this is its own module
 *
 * It is a LEAF: no imports, and it must stay that way. The renderer reads it,
 * and `renderer/lib/__tests__/renderer-main-boundary.test.ts` allows a renderer
 * file to name a `main/` module only when that module pulls in nothing — because
 * TypeScript type-checks every file a program reaches, so one runtime import
 * here would drag main-process code into the renderer's compilation. Its sibling
 * `builtins.ts` imports the fancy-flow engine, which is precisely why this
 * cannot live there.
 *
 * Hiding a kind from the palette was impossible before fancy-flow 0.66.0:
 * `<FlowEditor>` narrowed by node CATEGORY and not by kind, and the only
 * workaround — re-categorising Genie's own nodes until a category filter
 * happened to exclude fancy's — would have distorted the taxonomy to hide a gap.
 * That was filed upstream instead (fancy-flow #14), and `kindFilter` is the
 * answer.
 */
export const PAUSES_WITHOUT_RESUME: ReadonlySet<string> = new Set([
    '@particle-academy/human_approval',
    '@particle-academy/user_input',
    '@particle-academy/rich_user_input',
]);

/** The one sentence, shared by admission and the door so they cannot diverge. */
export const PAUSE_UNSUPPORTED =
    'it waits for a person, and Genie cannot resume a paused flow yet — so this step would stop the run for good rather than continuing after an answer. Ask with the “Force the question” step instead, which returns straight away.';

/**
 * Why each refused kind is refused, in the author's own terms.
 *
 * Data rather than a switch, so adding a kind means adding a sentence — and a
 * kind with no sentence falls through to the generic refusal rather than being
 * admitted by omission.
 */
const REFUSALS: Readonly<Record<string, string>> = {
    api_request:
        'it makes arbitrary web requests, and a flow that can call any URL is not bounded by what this app was allowed to do. Use a Genie step for the thing you actually want to reach.',
    webhook_out: 'it posts to arbitrary URLs. See “API Request” — the same reason.',
    tool_use: 'Genie does not host tool-calling models. Run an agent step instead.',
    embed_search: 'Genie has no embedding store wired to flows. Use the Knowledge step.',
    llm_call:
        'Genie does not call models directly from a flow — the spend and the attribution would belong to nobody. Use an agent step, which runs under an agent that has both.',
    llm_router: 'it routes by calling a model. See “LLM Call” — the same reason.',
    notify:
        'its channels are somebody else’s (Slack, email). Use the “Tell the user” step, which reaches this user where they already are.',
    memory_store: 'Genie has not decided where a flow’s data lives or who may read it, so it will not store any yet.',
    data_store: 'Genie has not decided where a flow’s data lives or who may read it, so it will not store any yet.',
    subflow:
        'running another flow needs an answer to whose permissions the inner flow acts under, and Genie does not have one yet.',
    for_each:
        'Genie runs a graph once through, so it cannot yet repeat the steps after this one per item. Fan out with a Run Agent step, or handle the list in one step.',
    webhook_trigger:
        'Genie has nowhere for an inbound request to land yet, so this flow will only run when started by hand or by another trigger.',
    // Arrived in the palette with fancy-flow 0.66.0, in the `io` category right
    // beside Genie's own steps. They drive a pty through the package's new
    // `TerminalHost` capability, and nothing calls `registerTerminalHost` here —
    // so today they would fail whatever this table said.
    //
    // Worth stating plainly, because the gap is small: 0.66.0 also ships
    // `@particle-academy/fancy-flow/terminal/fancy-term-host`, an adapter whose
    // own docs describe its intended consumer as "a desktop app that has already
    // wired `fancy-term-host` and holds a live backend", verified against
    // `fancy-term-host@0.5.0` — which is exactly the package and major Genie
    // pins for its terminals. Wiring it is a decision about whose terminals a
    // flow gets to drive and who sees them, and nobody has made it. So these say
    // "not yet", not "never", and point at the step that works today.
    terminal_run:
        'Genie has not wired a terminal for flows to drive yet, so this step has nothing to run in. Use the Manage Terminals step, which works in a real Genie terminal you can watch and take over.',
    terminal_send: 'it types into a terminal a flow cannot open yet. See “Run in terminal” — the same reason.',
    terminal_await: 'it waits on a terminal a flow cannot open yet. See “Run in terminal” — the same reason.',
    // `terminal_lane` is deliberately absent: it is a `layout` kind, and the
    // engine skips that whole category before an executor is chosen, so a
    // refusal here could never fire. Pinned by a test rather than trusted.
};

/** Why Genie refuses this kind, or null when it has no stated reason. */
export function refusalFor(canonicalKind: string): string | null {
    if (PAUSES_WITHOUT_RESUME.has(canonicalKind)) return PAUSE_UNSUPPORTED;
    const bare = canonicalKind.replace(/^@[^/]+\//, '');
    return REFUSALS[bare] ?? null;
}
