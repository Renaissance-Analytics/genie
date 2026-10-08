import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { acpEngineRow } from '../acp-engine-setting';

/**
 * THE SWITCH THAT DECIDES WHAT GENIE 2 IS — and it had no UI at all.
 *
 * `main/db.ts` says it in its own words: *"Absent or 'off' means the pty, which is the DEFAULT and
 * stays the default until **the owner moves it** — Genie 2 is a parallel surface."* Measured while
 * trying to close out the release: `acp_engine` appears in `main/db.ts` and in four test files, and
 * in **zero** renderer files and **zero** IPC definitions. So "until the owner moves it" described
 * something the owner could not do through the product — the only route was editing SQLite by hand.
 *
 * That is the shape this whole phase has been clearing out, one step further along: not built and
 * unwired, but *wired and unreachable*. Every mechanism exists and works — `engineFor` reads the
 * setting, `settings:set` already persists any key, the column is already typed — and the decision
 * the release hinges on had no control.
 *
 * ## Why the COPY is what gets tested
 *
 * Adding a `Switch` is three lines of a pattern this page uses a dozen times. The part that can be
 * WRONG is what it claims, and two honesty clauses are load-bearing:
 *
 *  - **Turning it on moves nothing that is already running.** A pty agent keeps its pty until it is
 *    relaunched. The owner has codex agents running right now; a toggle implying they switch would
 *    be a lie that costs trust in the setting the first time somebody checks.
 *  - **A provider with no ACP mode stays on the pty regardless**, so this is permission rather than
 *    a promise — `db.ts`'s phrasing, and the distinction C22 exists to protect: capability and
 *    routing are separate, and conflating them once sent every codex agent to an engine that refused
 *    it.
 *
 * And when it is OFF the row has to explain the consequence people actually notice, which is that
 * there is no Conversation tab — otherwise the most-asked question about Genie 2 has no answer
 * anywhere in the product.
 */

describe('acpEngineRow — what the switch says when it is OFF', () => {
    const off = acpEngineRow(false);

    it('names the CONSEQUENCE, not the mechanism', () => {
        // "acp_engine is off" means nothing to anyone. "There is no Conversation tab" is the thing
        // they are looking at and cannot explain.
        expect(off.desc.toLowerCase()).toContain('conversation');
    });

    it('says agents run in a terminal, which is what they will see', () => {
        expect(off.desc.toLowerCase()).toMatch(/terminal|pty/);
    });

    it('does not describe itself as experimental or unfinished', () => {
        // It is neither — it is a measured, proven path held back by a rollout decision. Calling it
        // experimental would be the product apologising for a choice the owner made deliberately.
        expect(off.desc.toLowerCase()).not.toContain('experimental');
        expect(off.desc.toLowerCase()).not.toContain('unstable');
    });
});

describe('acpEngineRow — what it says when it is ON, where the lies would be', () => {
    const on = acpEngineRow(true);

    it('says RUNNING AGENTS DO NOT MOVE until they are relaunched', () => {
        // The first honesty clause. Without it, somebody turns this on, looks at an agent that is
        // mid-work, finds no Conversation tab, and concludes the setting is broken.
        expect(on.desc.toLowerCase()).toMatch(/relaunch|restart|new agents|next time/);
    });

    it('says a provider without ACP stays on the terminal — permission, not a promise', () => {
        // `db.ts`: "a provider with no ACP mode stays on the pty regardless, so turning it on is
        // permission rather than a promise." The second honesty clause, and the one C22 protects.
        expect(on.desc.toLowerCase()).toMatch(/not every|some|only|providers that/);
    });

    it('does not claim every agent becomes a structured session', () => {
        // The specific overclaim to avoid. `engineFor` holds an agent on the pty when its command
        // carries anything Genie did not add, and `withCodexMcpLaunch` weaves `-c` TOML into every
        // codex command in an MCP-enabled workspace — so most codex agents stay on the pty anyway.
        expect(on.desc.toLowerCase()).not.toMatch(/every agent (will|now) /);
    });
});

describe('acpEngineRow — the row itself', () => {
    it('has a label that says what it DOES, not what it is called', () => {
        const { label } = acpEngineRow(false);
        expect(label).not.toContain('acp_engine');
        expect(label.length).toBeGreaterThan(8);
    });

    it('is findable by search, including by the word people will actually type', () => {
        // This page has a search box and `SettingRow` takes `keywords`. A setting nobody can find is
        // the same as a setting that does not exist, which is where this one started.
        const { keywords } = acpEngineRow(false);
        for (const word of ['acp', 'conversation', 'engine', 'session']) {
            expect(keywords.toLowerCase(), word).toContain(word);
        }
    });

    it('differs between the two states, so the row is not static decoration', () => {
        // The positive control for every assertion above: if `desc` ignored its argument, the ON and
        // OFF cases would both pass whichever one happened to be written.
        expect(acpEngineRow(true).desc).not.toBe(acpEngineRow(false).desc);
    });
});

/**
 * WIRED, not merely written. `acp_engine` reaching zero renderer files is exactly how this gap
 * existed in the first place, so the guard is on the page rather than on the helper.
 */
describe('the Settings page renders it', () => {
    const src = readFileSync(path.resolve(__dirname, '../../pages/settings.tsx'), 'utf8').replace(/\r\n/g, '\n');

    it('binds a Switch to the acp_engine setting', () => {
        expect(src).toContain("s.acp_engine === 'on'");
        expect(src).toContain("acp_engine: on ? 'on' : 'off'");
    });

    it('takes its copy from the tested helper rather than inlining prose', () => {
        expect(src).toContain('acpEngineRow(');
        expect(src).toContain("from '../lib/acp-engine-setting'");
    });

    it('positive control: the guard reads the real page', () => {
        expect(src).toContain('<SettingRow');
        expect(src).not.toContain("s.acp_engine_that_does_not_exist");
    });
});
