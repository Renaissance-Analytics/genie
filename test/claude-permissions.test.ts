import { claudeArgs } from '@particle-academy/prism-acp';
import { describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { claudeOptionsFor } from '../src/main/session-host.js';

/**
 * A CLAUDE AGENT CAN RUN ITS TOOLS (the owner's moic agent, using beta.19: Bash and PowerShell "refused because the
 * session runs in 'don't ask' permission mode" — no git log, no artisan, no tests). Claude's driver cannot ask a person
 * for approval (prism-acp's CLAUDE_DRIVER_CAPABILITIES.permissionRequests is false), and Genie started it with no
 * permission mode, so Claude Code refused every tool that needs one. Now each Claude agent starts with its own
 * setting: `all` (the default, existing agents included) → `--permission-mode bypassPermissions`; `edits` →
 * `acceptEdits` (file edits go through, shell is still refused). Measured through prism-acp's own `claudeArgs`, the
 * argv the CLI receives.
 */
const argvFor = (permissions?: 'all' | 'edits') => {
    const r = { ...agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'moic' }), ...(permissions ? { permissions } : {}) };
    return claudeArgs(claudeOptionsFor(r, '/w/tynn', null));
};
const modeIn = (argv: readonly string[]) => argv[argv.indexOf('--permission-mode') + 1];

describe('the permission mode Claude starts with', () => {
    it('all tools by default — an agent with no setting (every existing one) can run its shell', () => {
        expect(modeIn(argvFor())).toBe('bypassPermissions');
        expect(modeIn(argvFor('all'))).toBe('bypassPermissions');
    });

    it('edits only starts the SAME way (genie#1188): its shell refusal is the permission hook, answered per call', () => {
        expect(modeIn(argvFor('edits'))).toBe('bypassPermissions');
        expect(argvFor('edits')).toEqual(argvFor('all'));
    });

    it('carries the cwd and the resume through unchanged', () => {
        const r = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'moic' });
        expect(claudeOptionsFor(r, '/w/tynn', 'sess-1')).toMatchObject({ cwd: '/w/tynn', resumeSessionId: 'sess-1', permissionMode: 'bypassPermissions' });
    });
});
