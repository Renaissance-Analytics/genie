import { describe, expect, it } from 'vitest';
import { PROVIDER_IDS, TUI_REGISTRY, agentTuis, providerDef, type AgentTuiId } from '../registry';
import { AGENT_CLI_CATALOG, agentCliForProvider } from '../agent-cli-catalog';

/**
 * THE PROVIDER LIST THE OWNER ASKED FOR — and the one field in it that can lose
 * someone's work.
 *
 * Every agent CLI Genie knows about is now a launchable provider, not merely an
 * installable one. That makes `TuiDef.resume` the dangerous field in this
 * change, for a reason that is not obvious: **a wrong resume flag does not
 * error.** It starts a FRESH conversation while the UI says "restart", and the
 * user loses the thread with no message. A wrong binary name fails loudly on the
 * first launch; a wrong resume grammar fails silently, once, at the worst
 * possible moment.
 *
 * So the rule these tests enforce is the registry's own, from the entry that
 * first stated it: "No documented resume grammar, so a 'restart' would silently
 * start a NEW conversation. Withholding the button is the honest answer until
 * the CLI's own resume syntax is known."
 *
 * `resume: null` is therefore the CORRECT value for every provider whose syntax
 * was not read out of its own documentation. It is not a TODO.
 */

/**
 * The providers whose resume syntax was READ FROM VENDOR DOCUMENTATION, and
 * where it was read. Anything not on this list must be `null` — that is the
 * assertion, and it is the whole point of the list.
 */
const VERIFIED_RESUME: Partial<Record<AgentTuiId, string>> = {
    claude: 'claude --help',
    codex: 'codex --help',
    opencode: 'opencode.ai/docs/cli',
    auggie: 'docs.augmentcode.com/cli/reference',
    droid: 'docs.factory.ai/cli/configuration/cli-reference',
    cursor: 'cursor.com/docs/cli/reference/parameters',
    vibe: 'github.com/mistralai/mistral-vibe README',
};

describe('the expanded provider list', () => {
    it('replaces the phantom kiwi with Kilo Code, which is a real product', () => {
        expect(PROVIDER_IDS).not.toContain('kiwi');
        expect(PROVIDER_IDS).toContain('kilo');
        expect(TUI_REGISTRY.kilo.defaultCommand).toBe('kilo');
        expect(TUI_REGISTRY.kilo.label).toBe('Kilo Code');
    });

    it('makes every catalogued agent CLI launchable, except the one Genie will not probe', () => {
        for (const entry of AGENT_CLI_CATALOG) {
            if (entry.id === 'amazon-q') continue;
            expect(entry.provider, `${entry.id} has no provider`).toBeTruthy();
            expect(PROVIDER_IDS).toContain(entry.provider!);
        }
    });

    it('gives every provider but custom a CLI to launch', () => {
        for (const id of agentTuis()) {
            if (id === 'custom') continue;
            expect(agentCliForProvider(id), `${id} has no catalog entry`).toBeDefined();
        }
    });
});

describe('resume grammar — verified, or null', () => {
    it('wires a grammar ONLY where the syntax was read from the vendor own docs', () => {
        for (const id of agentTuis()) {
            const def = providerDef(id);
            if (VERIFIED_RESUME[id]) {
                expect(def.resume, `${id} should carry its verified grammar`).not.toBeNull();
            } else {
                // The load-bearing half. A guessed --resume costs a conversation.
                expect(def.resume, `${id} has an UNVERIFIED resume grammar`).toBeNull();
            }
        }
    });

    it('renders the exact syntax each vendor documents', () => {
        // `opencode --session <id>`, with `--continue` for the last session.
        expect(TUI_REGISTRY.opencode.resume).toMatchObject({
            kind: 'flag',
            token: '--session',
            continueFlag: '--continue',
        });
        // `auggie --resume <sessionId>`, `--continue` for the most recent.
        expect(TUI_REGISTRY.auggie.resume).toMatchObject({
            kind: 'flag',
            token: '--resume',
            continueFlag: '--continue',
        });
        // `cursor-agent --resume [chatId]`; `--continue` is the vendor's own
        // alias for the previous session.
        expect(TUI_REGISTRY.cursor.resume).toMatchObject({
            kind: 'flag',
            token: '--resume',
            continueFlag: '--continue',
        });
        // `droid --resume [sessionId]` — a BARE `--resume` resumes the last
        // modified session, so it is its own continue flag.
        expect(TUI_REGISTRY.droid.resume).toMatchObject({
            kind: 'flag',
            token: '--resume',
            continueFlag: '--resume',
        });
        // `vibe --resume SESSION_ID`, `--continue` for the most recent.
        expect(TUI_REGISTRY.vibe.resume).toMatchObject({
            kind: 'flag',
            token: '--resume',
            continueFlag: '--continue',
        });
    });

    /**
     * Kilo and Goose BOTH document a real way back into a conversation, and both
     * are `null` here on purpose — `ResumeGrammar` cannot express either shape.
     * Kilo has `--continue` but no resume-by-id, and `renderAgentResume` appends
     * the captured id to `token`, so `kilo --continue <id>` would be a command
     * the CLI never documented. Goose needs `goose session --resume --session-id
     * <id>`, a subcommand AND a flag, where `kind: 'subcommand'` puts the id
     * positionally last.
     *
     * Null is what those shapes honestly reduce to today: `resolveRestartCommand`
     * refuses the restart and SAYS it cannot resume, rather than building a
     * command that silently starts over.
     */
    it('is null for a documented syntax the grammar cannot yet express', () => {
        expect(TUI_REGISTRY.kilo.resume).toBeNull();
        expect(TUI_REGISTRY.goose.resume).toBeNull();
    });
});

describe('what Genie will and will not claim about a machine', () => {
    it('lists Amazon Q but never probes for it — q is too generic to detect', () => {
        const q = AGENT_CLI_CATALOG.find((e) => e.id === 'amazon-q');
        expect(q).toBeDefined();
        expect(q!.probe).toBe(false);
        expect(q!.install).toBeNull();
        expect(q!.installGap).toMatch(/Windows/i);
        // Never launchable either: spawning whatever `q` happens to be on PATH
        // is a worse fault than a false "installed".
        expect(q!.provider).toBeNull();
    });

    it('probes every other CLI — their binaries are specific enough to trust', () => {
        for (const entry of AGENT_CLI_CATALOG) {
            if (entry.id === 'amazon-q') continue;
            expect(entry.probe, entry.id).toBe(true);
        }
    });
});

describe('one fact, one place', () => {
    it('takes each CLI label and binary FROM the registry, never restating them', () => {
        for (const entry of AGENT_CLI_CATALOG) {
            if (!entry.provider) continue;
            // Not asserted-equal so much as structurally the same value: the
            // catalog carries no `label`/`bin` of its own for a provider-backed
            // entry, so there is nothing left to drift.
            expect(entry.label).toBe(TUI_REGISTRY[entry.provider].label);
            expect(entry.bin).toBe(TUI_REGISTRY[entry.provider].defaultCommand);
        }
    });
});
