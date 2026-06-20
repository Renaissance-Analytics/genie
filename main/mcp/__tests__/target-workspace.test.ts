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
