import { describe, expect, it } from 'vitest';
import { AGENT_DOC_FILES, agentDocsRouter } from '../agent-config';

describe('agentDocsRouter', () => {
    it('gives each harness only its own @ imports', () => {
        const codex = agentDocsRouter(AGENT_DOC_FILES.codex, { readme: true, rules: true });
        const claude = agentDocsRouter(AGENT_DOC_FILES.claude, { readme: true, rules: true });

        expect(codex).toBe('# Agent instructions\n\n@README.md\n@RULES.md\n@.agents/_genie/shared.md\n@.agents/_genie/genie-codex.md\n');
        expect(claude).toBe('# Agent instructions\n\n@README.md\n@RULES.md\n@.agents/_genie/shared.md\n@.agents/_genie/genie-claude.md\n');
        expect(codex).not.toContain('genie-claude.md');
        expect(claude).not.toContain('genie-codex.md');
    });

    it('only links workspace-owned context files that actually exist', () => {
        expect(agentDocsRouter(AGENT_DOC_FILES.codex, { readme: true, rules: false }))
            .toContain('@README.md\n@.agents/_genie/shared.md');
        expect(agentDocsRouter(AGENT_DOC_FILES.codex, { readme: false, rules: true }))
            .toContain('@RULES.md\n@.agents/_genie/shared.md');
        expect(agentDocsRouter(AGENT_DOC_FILES.codex, { readme: false, rules: false }))
            .not.toMatch(/@(?:README|RULES)\.md/);
    });

    it('defaults legacy and unknown callers to the Codex AGENTS.md router', () => {
        expect(agentDocsRouter('anything.md')).toBe(agentDocsRouter('AGENTS.md'));
    });
});

/**
 * THE OPERATOR CHARTER RIDES THE ROUTER, AND NOTHING BRANCHES ON THE OPERATOR.
 *
 * The workstation operator needs a boundary it reads every session ("you do not
 * do project work"), and the harness only loads what its instructions file
 * imports. The obvious way to arrange that is a check for the operator — and the
 * ceiling test in `main/__tests__/osa-special-cases.test.ts` exists precisely
 * because that is how the count got to 31.
 *
 * So the router does not know what an operator is. It links
 * `.agents/_genie/operator.md` when the workspace HAS one, exactly as it links
 * README.md and RULES.md when those exist — one uniform rule about files. Only
 * `wireGenieOsWorkspace` ever writes that file, so only `~/.gosa` ever gets the
 * import, and no shared surface had to learn a special case to make it happen.
 */
describe('agentDocsRouter — the operator charter', () => {
    it('links the charter when the workspace has one', () => {
        expect(agentDocsRouter(AGENT_DOC_FILES.codex, { readme: true, operator: true }))
            .toBe('# Agent instructions\n\n@README.md\n@.agents/_genie/shared.md\n@.agents/_genie/genie-codex.md\n@.agents/_genie/operator.md\n');
        expect(agentDocsRouter(AGENT_DOC_FILES.claude, { operator: true }))
            .toContain('@.agents/_genie/operator.md');
    });

    it('POSITIVE CONTROL — an ordinary workspace gets no such import', () => {
        // "It appears when asked for" passes just as well against a router that
        // always emits it, which would put an operator charter into every
        // project on the machine.
        for (const readme of [false, true]) {
            for (const rules of [false, true]) {
                const router = agentDocsRouter(AGENT_DOC_FILES.codex, { readme, rules });
                expect(router).not.toContain('operator.md');
                expect(router).toContain('@.agents/_genie/shared.md');
            }
        }
    });

    it('leaves every pre-existing router byte-identical', () => {
        // A router already on disk that no longer matches what this function
        // produces stops being recognised as Genie-managed — and `syncAgentsMd`
        // then treats it as the user's own instructions and MIGRATES it into
        // RULES.md. Adding a variant must not disturb the existing four.
        expect(agentDocsRouter(AGENT_DOC_FILES.codex, { readme: true, rules: true }))
            .toBe('# Agent instructions\n\n@README.md\n@RULES.md\n@.agents/_genie/shared.md\n@.agents/_genie/genie-codex.md\n');
        expect(agentDocsRouter(AGENT_DOC_FILES.claude, {}))
            .toBe('# Agent instructions\n\n@.agents/_genie/shared.md\n@.agents/_genie/genie-claude.md\n');
    });
});
