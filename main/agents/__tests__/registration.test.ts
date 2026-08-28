import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAgentRegistration } from '../registration';

describe('resolveAgentRegistration', () => {
    const root = path.resolve('/workspace');

    it('normalizes identity and resolves a contained boot folder', () => {
        expect(
            resolveAgentRegistration(root, {
                name: '  Release Reviewer  ',
                purpose: ' Review every release. ',
                bootFolder: 'repos/app',
            }),
        ).toMatchObject({
            ok: true,
            name: 'release-reviewer',
            purpose: 'Review every release.',
            bootCwd: path.resolve(root, 'repos/app'),
            personaPath: path.resolve(root, '.agents', 'release-reviewer', 'AGENT.md'),
        });
    });

    it('fails closed when a boot folder escapes the workspace', () => {
        const result = resolveAgentRegistration(root, {
            name: 'escape',
            purpose: 'Do not escape.',
            bootFolder: '../outside',
        });

        expect(result).toMatchObject({ ok: false });
        if (!result.ok) expect(result.error).toContain('inside the workspace');
    });

    it('requires a stated purpose', () => {
        expect(resolveAgentRegistration(root, { name: 'empty', purpose: '  ' })).toMatchObject({
            ok: false,
        });
    });
});
