import { describe, expect, it, vi } from 'vitest';
import {
    decideTargetWorkspace,
    resolveTargetWorkspace,
} from '../target-workspace';

describe('decideTargetWorkspace (pure)', () => {
    it('allows acting on the caller’s own workspace when no target is given', () => {
        const d = decideTargetWorkspace('ws-self', undefined, new Set());
        expect(d.allowed).toBe(true);
        expect(d.workspaceId).toBe('ws-self');
        expect(d.via).toBe('self');
    });

    it('allows acting on the caller’s own workspace when the target equals it', () => {
        const d = decideTargetWorkspace('ws-self', 'ws-self', new Set());
        expect(d.allowed).toBe(true);
        expect(d.via).toBe('self');
    });

    it('allows a governed child workspace', () => {
        const d = decideTargetWorkspace('ws-ops', 'ws-child', new Set(['ws-child']));
        expect(d.allowed).toBe(true);
        expect(d.workspaceId).toBe('ws-child');
        expect(d.via).toBe('governed');
    });

    it('denies an unrelated workspace (not self, not governed)', () => {
        const d = decideTargetWorkspace('ws-ops', 'ws-stranger', new Set(['ws-child']));
        expect(d.allowed).toBe(false);
        expect(d.via).toBe('denied');
        expect(d.reason).toContain('ws-stranger');
    });

    it('denies when the caller has no workspace at all (unattached terminal)', () => {
        const d = decideTargetWorkspace(null, undefined, new Set());
        expect(d.allowed).toBe(false);
        expect(d.via).toBe('denied');
    });

    it('denies a cross-workspace target even when the governed set is empty', () => {
        const d = decideTargetWorkspace('ws-a', 'ws-b', new Set());
        expect(d.allowed).toBe(false);
    });
});

describe('resolveTargetWorkspace (async)', () => {
    it('does NOT compute the governed set when acting on the caller’s own workspace', async () => {
        const governedWorkspaceIds = vi.fn().mockResolvedValue(new Set<string>());
        const d = await resolveTargetWorkspace(undefined, {
            callerWorkspaceId: 'ws-self',
            governedWorkspaceIds,
        });
        expect(d.allowed).toBe(true);
        expect(d.via).toBe('self');
        expect(governedWorkspaceIds).not.toHaveBeenCalled(); // no I/O on the fast path
    });

    it('computes the governed set only for a cross-workspace target', async () => {
        const governedWorkspaceIds = vi
            .fn()
            .mockResolvedValue(new Set(['ws-child']));
        const d = await resolveTargetWorkspace('ws-child', {
            callerWorkspaceId: 'ws-ops',
            governedWorkspaceIds,
        });
        expect(governedWorkspaceIds).toHaveBeenCalledTimes(1);
        expect(d.allowed).toBe(true);
        expect(d.via).toBe('governed');
    });

    it('fails CLOSED when the governance lookup throws', async () => {
        const governedWorkspaceIds = vi
            .fn()
            .mockRejectedValue(new Error('network down'));
        const d = await resolveTargetWorkspace('ws-child', {
            callerWorkspaceId: 'ws-ops',
            governedWorkspaceIds,
        });
        expect(d.allowed).toBe(false); // denied rather than fail-open
        expect(d.via).toBe('denied');
    });

    it('denies an unattached caller without any governance lookup', async () => {
        const governedWorkspaceIds = vi.fn();
        const d = await resolveTargetWorkspace('ws-child', {
            callerWorkspaceId: null,
            governedWorkspaceIds,
        });
        expect(d.allowed).toBe(false);
        expect(governedWorkspaceIds).not.toHaveBeenCalled();
    });
});

// --- Workstation Operator (Tynn story #248) ---------------------------------
//
// A workspace can be designated the WORKSTATION OPERATOR, which lets its agent
// act on every workspace on that machine — not only the child projects an Ops
// project governs.
//
// The need is concrete: hosting failures land in whichever workspace owns the
// site, while the agent with the engineering context is in another. Without this
// there is no site list, no status and no logs to read, so a blocked site cannot
// be diagnosed from the place that could fix it.
//
// It is a privilege escalation ACROSS workspace boundaries, so it is explicit,
// per-workspace, and off unless switched on. Nothing here grants it implicitly.

describe('a workspace designated WORKSTATION OPERATOR', () => {
    it('may act on any workspace on this workstation', () => {
        const decision = decideTargetWorkspace('ops-ws', 'some-other-ws', new Set(), {
            callerIsOperator: true,
        });

        expect(decision.allowed).toBe(true);
        expect(decision.workspaceId).toBe('some-other-ws');
        expect(decision.via).toBe('operator');
    });

    it('still reports GOVERNED for a governed child, which is the narrower truth', () => {
        // Both routes would allow it. The reason travels into approval prompts and
        // logs, so the more specific one is the useful one.
        const decision = decideTargetWorkspace('ops-ws', 'child-ws', new Set(['child-ws']), {
            callerIsOperator: true,
        });

        expect(decision.via).toBe('governed');
    });

    it('still reports SELF for its own workspace', () => {
        const decision = decideTargetWorkspace('ops-ws', 'ops-ws', new Set(), {
            callerIsOperator: true,
        });
        expect(decision.via).toBe('self');
    });
});

describe('without the operator designation', () => {
    it('is refused, exactly as before — this is opt-in, never implied', () => {
        const decision = decideTargetWorkspace('ws-a', 'ws-b', new Set());

        expect(decision.allowed).toBe(false);
        expect(decision.via).toBe('denied');
    });

    it('is refused when the flag is explicitly false', () => {
        const decision = decideTargetWorkspace('ws-a', 'ws-b', new Set(), {
            callerIsOperator: false,
        });
        expect(decision.allowed).toBe(false);
    });

    it('does not let an unattached terminal claim it', () => {
        // No caller workspace means no authority to escalate FROM. An operator
        // flag read from nowhere must not become authority over everything.
        const decision = decideTargetWorkspace(null, 'ws-b', new Set(), {
            callerIsOperator: true,
        });

        expect(decision.allowed).toBe(false);
        expect(decision.via).toBe('denied');
    });
});

describe('the built-in Genie OS agent', () => {
    it('is denied generic project access even with an explicit target', () => {
        const explicit = decideTargetWorkspace(null, 'project-1', new Set(), {
            callerIsOsAgent: true,
        });
        expect(explicit.allowed).toBe(false);
    });

    it('may target an explicit workspace only for an AgentBuilder capability', () => {
        const explicit = decideTargetWorkspace(null, 'project-1', new Set(), {
            osAgentCapability: 'agent-register',
        });
        expect(explicit.allowed).toBe(true);
        expect(explicit.workspaceId).toBe('project-1');
        expect(explicit.via).toBe('operator');

        const missing = decideTargetWorkspace(null, undefined, new Set(), {
            osAgentCapability: 'agent-register',
        });
        expect(missing.allowed).toBe(false);
    });
});
