import { describe, expect, it } from 'vitest';
import {
    parseAptUpgradable,
    parseBrewOutdated,
    parseNpmOutdated,
    parseWingetUpgrade,
} from '../toolchain-outdated';

/**
 * The real "what's the latest?" source behind P0's LatestFor (#242 P1) is a
 * package manager's own outdated/upgrade output. PARSING that output is pure, so
 * it's tested against each manager's documented format here; running the command
 * is the injected seam, wired after. Every parser NEVER throws — malformed input
 * yields `{}` (no update known), never a crash, matching the detection contract.
 */

describe('parseNpmOutdated (npm outdated -g --json)', () => {
    it('maps each package to its latest version', () => {
        const json = JSON.stringify({
            '@anthropic-ai/claude-code': { current: '1.0.40', wanted: '1.0.44', latest: '1.0.44' },
            '@openai/codex': { current: '0.4.0', wanted: '0.5.0', latest: '0.5.0' },
        });
        expect(parseNpmOutdated(json)).toEqual({
            '@anthropic-ai/claude-code': '1.0.44',
            '@openai/codex': '0.5.0',
        });
    });

    it('skips entries with no real latest (linked / git deps)', () => {
        const json = JSON.stringify({
            'some-pkg': { current: '1.0.0', latest: 'linked' },
            good: { current: '1.0.0', latest: '2.0.0' },
        });
        expect(parseNpmOutdated(json)).toEqual({ good: '2.0.0' });
    });

    it('returns {} for empty / invalid JSON', () => {
        expect(parseNpmOutdated('')).toEqual({});
        expect(parseNpmOutdated('not json')).toEqual({});
        expect(parseNpmOutdated('[]')).toEqual({});
    });
});

describe('parseBrewOutdated (brew outdated --json=v2)', () => {
    it('maps formulae AND casks to their current (latest) version', () => {
        const json = JSON.stringify({
            formulae: [
                { name: 'git', installed_versions: ['2.42.0'], current_version: '2.45.0' },
                { name: 'php', installed_versions: ['8.3.2'], current_version: '8.3.10' },
            ],
            casks: [{ name: 'docker', installed_versions: ['4.20.0'], current_version: '4.30.0' }],
        });
        expect(parseBrewOutdated(json)).toEqual({ git: '2.45.0', php: '8.3.10', docker: '4.30.0' });
    });

    it('returns {} for empty / invalid JSON', () => {
        expect(parseBrewOutdated('')).toEqual({});
        expect(parseBrewOutdated('garbage')).toEqual({});
    });
});

describe('parseAptUpgradable (apt list --upgradable)', () => {
    it('maps each package to its upgradable-to version, skipping the header', () => {
        const text = [
            'Listing... Done',
            'git/jammy-updates,jammy-security 1:2.34.1-1ubuntu1.11 amd64 [upgradable from: 1:2.34.1-1ubuntu1.9]',
            'nodejs/jammy 18.19.0-1nodesource1 amd64 [upgradable from: 18.18.0-1nodesource1]',
            '',
        ].join('\n');
        expect(parseAptUpgradable(text)).toEqual({
            git: '1:2.34.1-1ubuntu1.11',
            nodejs: '18.19.0-1nodesource1',
        });
    });

    it('returns {} for empty input', () => {
        expect(parseAptUpgradable('')).toEqual({});
        expect(parseAptUpgradable('Listing... Done\n')).toEqual({});
    });
});

describe('parseWingetUpgrade (winget upgrade)', () => {
    it('maps each package Id to its Available version, skipping header/separator/summary', () => {
        const text = [
            'Name                    Id                     Version      Available    Source',
            '-----------------------------------------------------------------------------',
            'Git                     Git.Git                2.42.0       2.45.0       winget',
            'Node.js LTS             OpenJS.NodeJS.LTS      20.11.0      20.15.0      winget',
            '2 upgrades available.',
        ].join('\n');
        expect(parseWingetUpgrade(text)).toEqual({
            'Git.Git': '2.45.0',
            'OpenJS.NodeJS.LTS': '20.15.0',
        });
    });

    it('returns {} for empty input', () => {
        expect(parseWingetUpgrade('')).toEqual({});
    });
});
