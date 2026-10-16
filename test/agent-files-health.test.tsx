import { describe, expect, it } from 'vitest';
import { AgentFilesHealth, agentFilesLine } from '../src/core/agent-files-health.js';

/**
 * NOTHING ABOUT A WORKSPACE'S AGENT FILES IS SILENT (the owner: "workspace agents cannot be left stranded"). The sync
 * upgrades a workspace's agent files on its own, at boot and when a workspace is added; until now what it changed and
 * what failed went to a console nobody reads. Every file a step touches is recorded, a failing step no longer stops the
 * steps after it, and each workspace's Settings shows its line: current, upgraded (what changed) or failed (which step,
 * why) — with when and who (test/workspace-agent-files.test.tsx). A config-sync failure is reported beside them and
 * cleared by the next good run.
 */
const W = '/w/moic';

describe('the record of a sync', () => {
    it('names every file a step touched, workspace-relative; a failing step is recorded and the next still runs', async () => {
        const health = new AgentFilesHealth();
        let ranAfter = false;
        const report = await health.run(W, [
            { step: 'protocol', run: async (touched) => { touched(`${W}/.agents/_genie/shared.md`); } },
            { step: 'routers', run: async () => { throw new Error('EACCES: permission denied, open CLAUDE.md'); } },
            { step: 'skills', run: async (touched) => { ranAfter = true; touched(`${W}/.claude/skills/genie/SKILL.md`); } },
        ], 1_000);
        expect(ranAfter).toBe(true);
        expect(report.changed).toEqual(['.agents/_genie/shared.md', '.claude/skills/genie/SKILL.md']);
        expect(report.failed).toEqual([{ step: 'routers', error: 'EACCES: permission denied, open CLAUDE.md' }]);
        expect(health.list()).toEqual([report]);
    });

    it('a config-sync failure is kept beside the docs run and cleared by the next good one', async () => {
        const health = new AgentFilesHealth();
        health.config(W, [{ label: 'Codex', ok: false, error: 'EBUSY' }, { label: 'Claude Code', ok: true }]);
        await health.run(W, [{ step: 'protocol', run: async () => {} }], 2_000);
        expect(health.list()[0]!.failed).toEqual([{ step: 'Codex', error: 'EBUSY' }]);
        health.config(W, [{ label: 'Codex', ok: true }]);
        expect(health.list()[0]!.failed).toEqual([]);
    });
});

describe('the line Settings shows', () => {
    it('current, upgraded (with what changed) or failed (with which step and why)', () => {
        expect(agentFilesLine({ workspacePath: W, at: 0, source: 'start', changed: [], failed: [] })).toBe('current');
        expect(agentFilesLine({ workspacePath: W, at: 0, source: 'start', changed: ['CLAUDE.md', 'RULES.md'], failed: [] })).toBe('upgraded: CLAUDE.md, RULES.md');
        expect(agentFilesLine({ workspacePath: W, at: 0, source: 'start', changed: ['a', 'b', 'c', 'd', 'e'], failed: [] })).toBe('upgraded: a, b, c (+2 more)');
        expect(agentFilesLine({ workspacePath: W, at: 0, source: 'start', changed: ['a'], failed: [{ step: 'routers', error: 'EACCES' }] })).toBe('failed: routers: EACCES');
    });

});
