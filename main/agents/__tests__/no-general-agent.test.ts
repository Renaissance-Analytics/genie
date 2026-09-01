import { describe, expect, it } from 'vitest';
import { normalizePurpose } from '../../agentinbox/types';
import { firstAgentRole } from '../first-agent-role';

/**
 * `general` is not a name Genie may invent, and the first agent is the TWA.
 *
 * The owner's rule: *"We should not be just spawning 'general' agents by
 * default. The first agent created is the workspace agent by default. No
 * 'general' terminology is allowed."*
 *
 * `normalizePurpose` returned the literal `'general'` for any agent that joined
 * without a stated purpose, so a terminal nobody named silently became
 * `{tui}:general` — indistinguishable from a name a human chose. On this
 * workstation that produced **7 of 29 agents** called `general`, across seven
 * workspaces, none deliberately created.
 *
 * Separately, `role = 'workspace'` had **zero** rows anywhere, despite the AMS
 * guide stating every workspace has a Workspace Agent by default. The role
 * exists in the schema and `deleteWorkspaceAgent` even refuses to delete one —
 * nothing ever created one.
 */

describe('the "general" fallback is the DEFAULT-AGENT name, not an accident (#324)', () => {
    it('still resolves an empty purpose to the workspace default agent name', () => {
        // Load-bearing: `runAgent start` with no name resolves to `general`
        // (agents/identity.ts, agents/saved.ts). Removing this outright broke 12
        // runAgent tests. The accidental mint is stopped at the ONE site that
        // lazily invents an agent from an unnamed terminal, which checks the RAW
        // purpose — see host-tools `agentInboxForMcp`.
        expect(normalizePurpose(undefined)).toBe('general');
    });

    it('still normalises a real purpose exactly as before', () => {
        expect(normalizePurpose('Tynn Builder')).toBe('tynn-builder');
        expect(normalizePurpose('  API   work  ')).toBe('api-work');
        expect(normalizePurpose('a b c d e f g h')).toBe('a-b-c-d-e-f');
    });
});

describe('the first agent in a workspace is the Workspace Agent (#324)', () => {
    it('is role=workspace when the workspace has no workspace agent', () => {
        expect(firstAgentRole({ hasWorkspaceAgent: false })).toBe('workspace');
    });

    it('is role=specialized once the workspace already has one', () => {
        expect(firstAgentRole({ hasWorkspaceAgent: true })).toBe('specialized');
        expect(firstAgentRole({ hasWorkspaceAgent: true })).toBe('specialized');
    });

    it('never claims the workspace role for a GApp agent', () => {
        // A GApp's agent belongs to the app, not the workspace, and the schema
        // allows only ONE role='workspace' row per workspace — handing it to a
        // GApp would lock the workspace out of ever having its own.
        expect(firstAgentRole({ hasWorkspaceAgent: false, kind: 'gapp' })).toBe('gapp');
    });
});
