import { describe, expect, it } from 'vitest';
import { GENIE_OS_AGENT, authorizeOsAgentTarget, obsoleteOsAgentSpecIds, osAgentMetaForProvider, osAgentLaunchCommand, authorizeOsAgentBoot } from '../os-agent';

describe('the hardcoded workstation Genie agent', () => {
    it('is workstation-scoped and cannot own a project', () => {
        expect(GENIE_OS_AGENT.name).toBe('Genie');
        expect(GENIE_OS_AGENT.role).toBe('workstation-operator');
        expect(GENIE_OS_AGENT.workspaceId).toBeNull();
        expect(GENIE_OS_AGENT.mutable).toBe(false);
        expect(GENIE_OS_AGENT.skills).toContain('genie-agent-builder');
    });

    it('refuses project work while allowing workstation operations', () => {
        expect(authorizeOsAgentTarget({ kind: 'workstation' }).allowed).toBe(true);
        const project = authorizeOsAgentTarget({ kind: 'project', workspaceId: 'project-1' });
        expect(project.allowed).toBe(false);
        if (!project.allowed) expect(project.reason).toMatch(/workstation|project/i);
    });

    it('switches its launch provider without losing workstation security metadata', () => {
        expect(osAgentMetaForProvider({
            system: true,
            agent: 'claude',
            agent_command: 'claude',
            agent_id: 'genie:workstation',
            whisper_scope: 'all',
        }, 'codex', 'codex --profile genie')).toEqual({
            system: true,
            agent: 'codex',
            agent_command: 'codex --profile genie',
            agent_id: 'genie:workstation',
            whisper_scope: 'all',
        });
    });

    it('always grants the workstation operator the provider full-access mode', () => {
        expect(osAgentLaunchCommand('claude', 'claude')).toBe('claude --dangerously-skip-permissions');
        expect(osAgentLaunchCommand('codex', 'codex --profile genie')).toBe('codex --profile genie --yolo');
        expect(osAgentLaunchCommand('codex', 'codex --yolo')).toBe('codex --yolo');
    });

    it('refuses setup completion until a native harness transport is verified', () => {
        expect(authorizeOsAgentBoot('claude', false).allowed).toBe(false);
        expect(authorizeOsAgentBoot('codex', false).allowed).toBe(false);
        expect(authorizeOsAgentBoot('claude', true).allowed).toBe(true);
        expect(authorizeOsAgentBoot('kilo', false).allowed).toBe(true);
    });
});

describe('legacy Genie OSA terminal convergence', () => {
    it('removes every duplicate while retaining the one canonical terminal', () => {
        expect(obsoleteOsAgentSpecIds([
            { id: 'legacy-one', meta: { agent_id: 'genie:workstation' } },
            { id: 'genie-workstation-agent', meta: { agent_id: 'genie:workstation' } },
            { id: 'legacy-two', meta: { agent_id: 'genie:workstation' } },
            { id: 'project-agent', meta: { agent_id: 'project:agent' } },
        ])).toEqual(['legacy-one', 'legacy-two']);
    });
});
