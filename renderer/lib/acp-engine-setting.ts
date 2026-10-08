/**
 * THE SWITCH THAT DECIDES WHAT GENIE 2 IS — which had no UI at all.
 *
 * `main/db.ts` states the rollout in its own words: *"Absent or 'off' means the pty, which is the
 * DEFAULT and stays the default until **the owner moves it** — Genie 2 is a parallel surface."*
 *
 * Measured while trying to close out the release: `acp_engine` appeared in `main/db.ts` and four test
 * files, and in **zero** renderer files and **zero** IPC definitions. So "until the owner moves it"
 * described something the owner could not do through the product — the only route was editing SQLite
 * by hand. Every mechanism was already there and working: `engineFor` reads the setting, `settings:set`
 * persists any key, the column is typed. The decision the release hinges on simply had no control.
 *
 * Not built-and-unwired, which is this phase's usual defect, but one step further along: **wired and
 * unreachable.**
 *
 * ## Why the copy lives here rather than inline
 *
 * The `Switch` is three lines of a pattern `settings.tsx` already uses a dozen times. What can be
 * WRONG is what it claims, and two clauses are load-bearing enough to be worth a tested unit:
 *
 *  - **Turning it on moves nothing already running.** A pty agent keeps its pty until it is
 *    relaunched. A toggle implying otherwise is a lie the first person to check will find.
 *  - **A provider with no ACP mode stays on the pty regardless** — `db.ts`'s *"permission rather than
 *    a promise"*, and the capability/routing distinction C22 exists to protect.
 *
 * Deliberately NOT called experimental. It is a measured path — a real child, a real turn, no API key
 * in the environment, on both providers — held back by a rollout decision. Calling it experimental
 * would be the product apologising for a deliberate choice.
 */

export interface AcpEngineRow {
    label: string;
    desc: string;
    /** For the page's search box. A setting nobody can find is a setting that does not exist, which
     *  is roughly where this one started. */
    keywords: string;
}

export function acpEngineRow(enabled: boolean): AcpEngineRow {
    return {
        label: 'Run agents as structured sessions',
        keywords:
            'acp engine structured session conversation agent transport declared fidelity composer approvals',
        desc: enabled
            ? 'On — providers that support ACP run as structured sessions, so an agent gets the '
              + 'Conversation tab: you can message it, approve or deny its tools and stop a turn, with '
              + 'its terminal one tab away and still live. Agents already running keep their terminal '
              + 'until you relaunch them, and not every provider has an ACP mode — those stay on the '
              + 'terminal, so this is permission rather than a promise.'
            : 'Off — every agent runs in a terminal, which is why an agent has no Conversation tab and '
              + 'cannot be messaged, approved or stopped from Genie. Turn this on to give agents whose '
              + 'provider supports it a structured session instead; the terminal stays available either '
              + 'way.',
    };
}
