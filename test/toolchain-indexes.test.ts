import { describe, expect, it } from 'vitest';
import { latestFromBrewOutdated, latestFromNodeIndex, latestFromNpmOutdated, latestFromWingetUpgrade, phpLatestFromReleases } from '../src/core/toolchain-indexes.js';

/**
 * WHERE "LATEST" COMES FROM — pure parsers over what each source actually returns, so the honest
 * `unknown` tone is earned: a source that cannot be parsed yields null, never a guessed version.
 * Fixtures are the real shapes (nodejs.org's index.json, php.net's releases JSON, `winget upgrade`,
 * `brew outdated --json`, `npm outdated -g --json`), trimmed.
 */

describe('nodejs.org index.json', () => {
    const index = [
        { version: 'v23.1.0', lts: false, date: '2026-10-01' },
        { version: 'v22.24.0', lts: 'Jod', date: '2026-09-28' },
        { version: 'v22.23.2', lts: 'Jod', date: '2026-09-10' },
        { version: 'v20.19.0', lts: 'Iron', date: '2026-08-01' },
    ];

    it('the latest LTS, by default — current releases are not what a workstation should be told to install', () => {
        expect(latestFromNodeIndex(index)).toEqual({ version: '22.24.0', source: 'nodejs.org index (LTS)' });
    });

    it('the latest within an installed major when asked, so a 20.x machine is offered 20.19, not 22', () => {
        expect(latestFromNodeIndex(index, { major: 20 })).toEqual({ version: '20.19.0', source: 'nodejs.org index (LTS)' });
    });

    it('garbage or an empty index → null', () => {
        expect(latestFromNodeIndex([])).toBeNull();
        expect(latestFromNodeIndex('nope' as never)).toBeNull();
        expect(latestFromNodeIndex([{ version: 'v23.1.0', lts: false }])).toBeNull();
    });
});

describe('php.net releases', () => {
    it('the newest stable version across the active branches', () => {
        const releases = { '8.4': { version: '8.4.12', date: '2026-09-25' }, '8.3': { version: '8.3.26', date: '2026-09-25' }, '8.2': { version: '8.2.30' } };
        expect(phpLatestFromReleases(releases)).toEqual({ version: '8.4.12', source: 'php.net releases' });
        expect(phpLatestFromReleases(releases, { major: 8, minor: 3 })).toEqual({ version: '8.3.26', source: 'php.net releases' });
        expect(phpLatestFromReleases({})).toBeNull();
    });
});

describe('winget upgrade', () => {
    const out = [
        'Name                 Id                 Version    Available  Source',
        '----------------------------------------------------------------------',
        'Git                  Git.Git            2.50.1     2.51.0     winget',
        'Node.js LTS          OpenJS.NodeJS.LTS  22.23.2    22.24.0    winget',
        '2 upgrades available.',
    ].join('\n');

    it('reads the Available column for a package id; a package not listed is null (no upgrade)', () => {
        expect(latestFromWingetUpgrade(out, 'Git.Git')).toEqual({ version: '2.51.0', source: 'winget upgrade' });
        expect(latestFromWingetUpgrade(out, 'OpenJS.NodeJS.LTS')).toEqual({ version: '22.24.0', source: 'winget upgrade' });
        expect(latestFromWingetUpgrade(out, 'PHP.PHP.8.4')).toBeNull();
    });

    it('winget’s "No installed package found" or an empty table → null, never a guess', () => {
        expect(latestFromWingetUpgrade('No installed package found matching input criteria.', 'Git.Git')).toBeNull();
        expect(latestFromWingetUpgrade('', 'Git.Git')).toBeNull();
    });
});

describe('brew outdated --json', () => {
    it('reads current_version for a formula; a formula not outdated is null', () => {
        const json = JSON.stringify({ formulae: [{ name: 'git', installed_versions: ['2.50.1'], current_version: '2.51.0' }], casks: [] });
        expect(latestFromBrewOutdated(json, 'git')).toEqual({ version: '2.51.0', source: 'brew outdated' });
        expect(latestFromBrewOutdated(json, 'php')).toBeNull();
        expect(latestFromBrewOutdated('not json', 'git')).toBeNull();
    });
});

describe('npm outdated -g --json', () => {
    it('reads latest for a global package; a package not outdated is null', () => {
        const json = JSON.stringify({ '@anthropic-ai/claude-code': { current: '2.0.10', wanted: '2.0.14', latest: '2.0.14', location: '…' } });
        expect(latestFromNpmOutdated(json, '@anthropic-ai/claude-code')).toEqual({ version: '2.0.14', source: 'npm registry' });
        expect(latestFromNpmOutdated(json, '@openai/codex')).toBeNull();
        // npm prints `{}` when nothing is outdated, and sometimes nothing at all.
        expect(latestFromNpmOutdated('{}', '@anthropic-ai/claude-code')).toBeNull();
        expect(latestFromNpmOutdated('', '@anthropic-ai/claude-code')).toBeNull();
    });
});
