import { describe, expect, it } from 'vitest';
import { AGENT_DOC_FILES, agentDocsRouter } from '../agent-config';

describe('agentDocsRouter', () => {
    it('gives Codex and Claude the exact same thin router', () => {
        const codex = agentDocsRouter(AGENT_DOC_FILES.codex);
        const claude = agentDocsRouter(AGENT_DOC_FILES.claude);

        expect(codex).toBe(claude);
        expect(codex).not.toContain('GENIE PROTOCOL');
        expect(codex.split('\n').filter((line) => line.trim()).length).toBeLessThan(16);
    });

    it('explicitly tells either harness to read every instruction source', () => {
        const router = agentDocsRouter('AGENTS.md');

        expect(router).toContain('read and follow');
        expect(router).toContain('.agents/_genie/shared.md');
        expect(router).toContain('.agents/_genie/genie-codex.md');
        expect(router).toContain('.agents/_genie/genie-claude.md');
        expect(router).toContain('README.md');
        expect(router).toContain('RULES.md');
        expect(router).not.toContain('@AGENTS.md');
    });

    it('is independent of the filename passed by legacy callers', () => {
        expect(agentDocsRouter('anything.md')).toBe(agentDocsRouter('CLAUDE.md'));
    });
});
