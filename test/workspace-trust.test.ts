import { describe, expect, it } from 'vitest';
import { npmRunTarget, parseGitConfigList, trustHash, trustVerdict, unsafeGitKeys, type TrustList } from '../src/core/workspace-trust.js';

/**
 * WHAT A WORKSPACE WOULD RUN, AND WHETHER THE PERSON HAS SAID YES TO IT. One record on this machine, one verdict, and a hash of the list that asks again when it changes. The pure half.
 */

const empty: TrustList = { sites: [], hooks: [], servers: [], gitKeys: [], approvals: [] };
const nul = String.fromCharCode(0);
const newline = String.fromCharCode(10);

describe('reading git config --list -z', () => {
    it('gives each key with its value, lower-cased keys, and a key with no value as empty', () => {
        expect(parseGitConfigList(`core.bare${newline}false${nul}Remote.Origin.URL${newline}https://x.invalid/a.git${nul}core.fsmonitor${nul}`)).toEqual([
            { key: 'core.bare', value: 'false' },
            { key: 'remote.origin.url', value: 'https://x.invalid/a.git' },
            { key: 'core.fsmonitor', value: '' },
        ]);
    });
    it('keeps a value that has a line break in it whole', () => {
        expect(parseGitConfigList(`a.b${newline}one${newline}two${nul}`)).toEqual([{ key: 'a.b', value: `one${newline}two` }]);
    });
});

describe('which git keys could run something', () => {
    const entry = (key: string, value = 'x') => ({ key, value });

    it('what a plain clone has is safe', () => {
        expect(unsafeGitKeys([
            entry('core.repositoryformatversion', '0'), entry('core.filemode', 'true'), entry('core.bare', 'false'), entry('core.logallrefupdates', 'true'), entry('core.ignorecase', 'true'), entry('core.symlinks', 'false'), entry('core.autocrlf', 'true'),
            entry('remote.origin.url', 'git@github.com:a/b.git'), entry('remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'), entry('branch.main.remote', 'origin'), entry('branch.main.merge', 'refs/heads/main'),
            entry('user.name', 'A'), entry('user.email', 'a@example.invalid'), entry('submodule.x.url', 'https://x.invalid/x.git'), entry('submodule.x.active', 'true'),
        ])).toEqual([]);
    });

    it.each(['core.fsmonitor', 'core.sshcommand', 'core.pager', 'core.editor', 'core.askpass', 'core.hookspath', 'core.gitproxy', 'core.worktree', 'diff.external', 'diff.x.textconv', 'diff.x.command', 'filter.x.clean', 'filter.x.smudge', 'filter.x.process', 'merge.x.driver', 'credential.helper', 'gpg.program', 'sequence.editor', 'pager.status', 'alias.st', 'interactive.difffilter', 'remote.origin.uploadpack', 'submodule.x.update', 'include.path', 'includeif.gitdir:/x.path'])('%s is not', (key) => {
        expect(unsafeGitKeys([entry(key)]).map((e) => e.key)).toEqual([key]);
    });

    it('a key nobody has listed is not assumed safe', () => {
        expect(unsafeGitKeys([entry('newtool.command')]).map((e) => e.key)).toEqual(['newtool.command']);
    });

    it('an ext:: remote is not safe, though a remote url is', () => {
        expect(unsafeGitKeys([entry('remote.origin.url', 'ext::sh -c x')]).map((e) => e.key)).toEqual(['remote.origin.url']);
    });
});

describe('the script an npm command names', () => {
    it.each([['npm run dev', 'dev'], ['npm run dev -- --port {port}', 'dev'], ['npm run-script build', 'build'], ['npm --prefix x run dev', null], ['node server.js', null], ['npm test', null]])('%s is %s', (command, name) => {
        expect(npmRunTarget(command)).toBe(name);
    });
});

describe('the hash', () => {
    const list = (over: Partial<TrustList>): TrustList => ({ ...empty, ...over });
    const site = { key: 'k1', fingerprint: 'f1', runs: 'npm run dev', folder: '.', npmScript: 'vite' };

    it('does not depend on the order things were found in', () => {
        const a = { file: '.mcp.json', name: 'a', command: 'x' };
        const b = { file: '.mcp.json', name: 'b', command: 'y' };
        expect(trustHash(list({ servers: [a, b] }))).toBe(trustHash(list({ servers: [b, a] })));
    });

    it.each<[string, Partial<TrustList>]>([
        ['a site', { sites: [site] }],
        ['a hook', { hooks: [{ file: '.claude/settings.json', event: 'Stop', command: 'x' }] }],
        ['a server', { servers: [{ file: '.mcp.json', name: 'a', command: 'x' }] }],
        ['a git key', { gitKeys: [{ key: 'core.fsmonitor', value: 'x' }] }],
    ])('changes with %s', (_what, over) => {
        expect(trustHash(list(over))).not.toBe(trustHash(empty));
    });

    it('changes when the npm script a site runs changes, with the command the same', () => {
        expect(trustHash(list({ sites: [site] }))).not.toBe(trustHash(list({ sites: [{ ...site, npmScript: 'something else' }] })));
    });
});

describe('the verdict', () => {
    const hash = trustHash({ ...empty, gitKeys: [{ key: 'a', value: 'b' }] });
    const book = (over: Record<string, unknown> = {}) => ({ carried: [] as string[], workspaces: {} as Record<string, string>, ...over });

    it('nothing said yet: untrusted', () => { expect(trustVerdict(book(), 'acme', hash)).toEqual({ trusted: false, changed: false }); });
    it('the person said yes to this list: trusted', () => { expect(trustVerdict(book({ workspaces: { acme: hash } }), 'acme', hash)).toEqual({ trusted: true, changed: false }); });
    it('the list has changed since: untrusted, and it says so', () => { expect(trustVerdict(book({ workspaces: { acme: 'older' } }), 'acme', hash)).toEqual({ trusted: false, changed: true }); });
    it('carried over at the upgrade, with no list recorded yet: trusted', () => { expect(trustVerdict(book({ carried: ['acme'] }), 'acme', hash)).toEqual({ trusted: true, changed: false }); });
    it('carried over, then the list recorded, then changed: it asks again', () => { expect(trustVerdict(book({ carried: ['acme'], workspaces: { acme: 'older' } }), 'acme', hash)).toEqual({ trusted: false, changed: true }); });
    it('a workspace with nothing that would run is trusted without asking', () => { expect(trustVerdict(book(), 'acme', trustHash(empty))).toEqual({ trusted: true, changed: false }); });
});
