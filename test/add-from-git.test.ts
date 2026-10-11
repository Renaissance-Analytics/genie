import { describe, expect, it } from 'vitest';
import { gitAddPlan, repoFolderName } from '../src/core/workspace-model.js';
import { addWorkspaceFromGit, previewAddFromGit, type WorkspaceOpsPorts } from '../src/main/workspace-ops-host.js';

/**
 * ADD A WORKSPACE FROM A GIT URL (§6.1 sources). The plan is shown BEFORE anything is written: the folder
 * the clone lands in (derived from the URL, under a parent the person picked), the clone step marked as a
 * write, then the ordinary simple-repo plan. A URL that is not git, or a folder that already exists, is a
 * reason, never a half clone. Confirm clones through a port and continues with the existing add flow; a
 * failing clone is reported in git's own words and registers nothing.
 */

describe('repoFolderName', () => {
    it('derives the folder from https and ssh URLs, dropping .git and a trailing slash; refuses what is not a git URL', () => {
        expect(repoFolderName('https://github.com/example/fancy-ui.git')).toBe('fancy-ui');
        expect(repoFolderName('https://github.com/example/fancy-ui/')).toBe('fancy-ui');
        expect(repoFolderName('git@github.com:example/tynn.git')).toBe('tynn');
        expect(repoFolderName('ssh://git@example.test/team/repo.git')).toBe('repo');
        expect(repoFolderName('not a url')).toBeNull();
        expect(repoFolderName('https://example.test/')).toBeNull();
        expect(repoFolderName('file:///w/tynn')).toBeNull();
    });
});

describe('gitAddPlan', () => {
    it('names the folder under the parent, puts the clone first (a write), then the simple-repo plan; refusals are reasons', () => {
        const plan = gitAddPlan({ url: 'https://github.com/example/fancy-ui.git', parent: '/w', folderExists: false });
        expect(plan).toMatchObject({ ok: true, url: 'https://github.com/example/fancy-ui.git', path: '/w/fancy-ui', kind: 'simple-repo' });
        const steps = (plan as { ok: true; steps: Array<{ action: string; path: string; writes: boolean }> }).steps;
        expect(steps[0]).toEqual({ action: 'git clone https://github.com/example/fancy-ui.git into /w/fancy-ui', path: '/w/fancy-ui', writes: true });
        expect(steps.some((s) => s.action.startsWith('write project.json'))).toBe(true);
        expect(gitAddPlan({ url: 'nope', parent: '/w', folderExists: false })).toEqual({ ok: false, reason: '"nope" is not a git URL Genie can clone (https://…/name.git or git@host:owner/name.git)' });
        expect(gitAddPlan({ url: 'https://github.com/example/fancy-ui.git', parent: '/w', folderExists: true })).toEqual({ ok: false, reason: '/w/fancy-ui already exists; add that folder instead of cloning over it' });
    });
});

function fakes(opts: { exists?: string[]; cloneFails?: string } = {}) {
    const calls: string[] = [];
    const files: Record<string, unknown> = {};
    const existing = new Set(opts.exists ?? []);
    const key = (p: string) => p.replace(/\\/g, '/');
    const ports = {
        fs: {
            exists: async (p: string) => existing.has(key(p)),
            entries: async (p: string) => (existing.has(key(p)) ? ['.git', 'src'] : []),
            readJson: async (p: string) => files[key(p)] ?? null,
            writeJson: async (p: string, v: unknown) => { calls.push(`writeJson:${key(p)}`); files[key(p)] = v; },
            mkdir: async (p: string) => { calls.push(`mkdir:${key(p)}`); },
            gitInit: async (p: string) => { calls.push(`gitInit:${key(p)}`); },
            gitClone: async (url: string, into: string) => {
                calls.push(`gitClone:${url}:${key(into)}`);
                if (opts.cloneFails) throw new Error(opts.cloneFails);
                existing.add(key(into));
            },
        },
        registry: {
            workspace: () => null,
            addWorkspace: async (w: { id: string; path: string }) => { calls.push(`addWorkspace:${w.id}:${key(w.path)}`); },
            agentsOf: () => [],
            setAsleep: async () => true,
            forgetWorkspace: async () => null,
        },
        host: { probe: () => null, prompt: () => true, stop: () => true },
        attention: { finished: () => [] },
        terminals: { list: () => [], close: () => true },
        supervisor: { list: () => [], stop: () => true },
        now: () => 0,
        sleep: async () => {},
    } as unknown as WorkspaceOpsPorts;
    return { ports, calls, files };
}

describe('previewAddFromGit / addWorkspaceFromGit', () => {
    it('preview writes nothing; confirm clones, then runs the ordinary add and registers; a failing clone reports git\'s words and registers nothing', async () => {
        const f = fakes();
        expect(await previewAddFromGit(f.ports, 'https://github.com/example/fancy-ui.git', '/w')).toMatchObject({ ok: true, path: '/w/fancy-ui', kind: 'simple-repo' });
        expect(f.calls).toEqual([]);
        expect(await addWorkspaceFromGit(f.ports, 'https://github.com/example/fancy-ui.git', '/w')).toMatchObject({ ok: true, id: 'fancy-ui', kind: 'simple-repo' });
        expect(f.calls[0]).toBe('gitClone:https://github.com/example/fancy-ui.git:/w/fancy-ui');
        expect(f.calls).toContain('addWorkspace:fancy-ui:/w/fancy-ui');
        expect(f.calls.indexOf('gitClone:https://github.com/example/fancy-ui.git:/w/fancy-ui')).toBeLessThan(f.calls.indexOf('writeJson:/w/fancy-ui/project.json'));

        const failing = fakes({ cloneFails: "fatal: repository 'https://github.com/example/nope.git/' not found" });
        expect(await addWorkspaceFromGit(failing.ports, 'https://github.com/example/nope.git', '/w')).toEqual({ ok: false, reason: "git clone failed: fatal: repository 'https://github.com/example/nope.git/' not found" });
        expect(failing.calls.some((c) => c.startsWith('addWorkspace:'))).toBe(false);

        const taken = fakes({ exists: ['/w/fancy-ui'] });
        expect(await previewAddFromGit(taken.ports, 'https://github.com/example/fancy-ui.git', '/w')).toMatchObject({ ok: false, reason: expect.stringMatching(/already exists/) });
    });
});
