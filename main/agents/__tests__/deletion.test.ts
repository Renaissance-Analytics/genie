import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAgentDeletion } from '../deletion';

/**
 * What UNMOUNT vs DELETE touches on disk (genie#311) — pure, so the boundary
 * guard is testable without fs or a real database.
 *
 * Mirrors `resolveAgentRegistration`'s guard in `registration.test.ts`: a
 * registered agent's persona path was computed with the same containment
 * check at write time, so removal has to fail closed the same way.
 */
describe('resolveAgentDeletion', () => {
    const root = path.resolve('/workspace');
    const personaPath = path.resolve(root, '.agents', 'ripple-builder', 'AGENT.md');

    it('UNMOUNT never removes a file, even when a persona exists', () => {
        const result = resolveAgentDeletion(
            root,
            { id: 'a1', role: 'specialized', persona_path: personaPath },
            'unmount',
        );
        expect(result).toMatchObject({ ok: true, plan: { removeFiles: false, agentDir: null } });
    });

    it('DELETE removes exactly the agent’s own .agents/<name>/ folder', () => {
        const result = resolveAgentDeletion(
            root,
            { id: 'a1', role: 'specialized', persona_path: personaPath },
            'delete',
        );
        expect(result).toMatchObject({
            ok: true,
            plan: {
                removeFiles: true,
                agentDir: path.resolve(root, '.agents', 'ripple-builder'),
            },
        });
    });

    it('DELETE with no persona file removes nothing — there is nothing to remove', () => {
        const result = resolveAgentDeletion(
            root,
            { id: 'a1', role: 'specialized', persona_path: null },
            'delete',
        );
        expect(result).toMatchObject({ ok: true, plan: { removeFiles: false, agentDir: null } });
    });

    it('fails closed when a hand-edited persona_path escapes .agents/', () => {
        // A human can edit AGENT.md's frontmatter, but not the DB row that
        // points at it — a `persona_path` that no longer resolves under
        // `.agents/` must never turn a single agent's delete into removing
        // some other folder entirely.
        const escaped = path.resolve(root, 'repos', 'app', 'AGENT.md');
        const result = resolveAgentDeletion(
            root,
            { id: 'a1', role: 'specialized', persona_path: escaped },
            'delete',
        );
        expect(result).toMatchObject({ ok: true, plan: { removeFiles: false, agentDir: null } });
    });

    it('refuses to remove .agents/ itself even if persona_path points directly at it', () => {
        const atRoot = path.resolve(root, '.agents', 'AGENT.md');
        const result = resolveAgentDeletion(
            root,
            { id: 'a1', role: 'specialized', persona_path: atRoot },
            'delete',
        );
        expect(result).toMatchObject({ ok: true, plan: { removeFiles: false, agentDir: null } });
    });

    it('refuses to delete the WORKSPACE agent, in either mode', () => {
        for (const mode of ['unmount', 'delete'] as const) {
            const result = resolveAgentDeletion(
                root,
                { id: 'workspace:x', role: 'workspace', persona_path: null },
                mode,
            );
            expect(result.ok).toBe(false);
        }
    });
});
