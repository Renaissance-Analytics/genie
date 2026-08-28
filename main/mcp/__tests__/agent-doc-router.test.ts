import { describe, expect, it } from 'vitest';
import { AGENT_DOC_FILES, agentDocsRouter } from '../agent-config';

describe('agentDocsRouter', () => {
    it('gives each harness only its own @ imports', () => {
        const codex = agentDocsRouter(AGENT_DOC_FILES.codex);
        const claude = agentDocsRouter(AGENT_DOC_FILES.claude);

        expect(codex).toBe('# Agent instructions\n\n@.agents/_genie/shared.md\n@.agents/_genie/genie-codex.md\n');
        expect(claude).toBe('# Agent instructions\n\n@.agents/_genie/shared.md\n@.agents/_genie/genie-claude.md\n');
        expect(codex).not.toContain('genie-claude.md');
        expect(claude).not.toContain('genie-codex.md');
    });

    it('defaults legacy and unknown callers to the Codex AGENTS.md router', () => {
        expect(agentDocsRouter('anything.md')).toBe(agentDocsRouter('AGENTS.md'));
    });
});
