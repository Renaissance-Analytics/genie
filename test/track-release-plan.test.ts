import { describe, expect, it } from 'vitest';
import {
    fingerprintAssetName,
    fingerprintOf,
    hostOnlyFiles,
    importsOf,
    lastPublished,
    parseRoundTag,
    tracksToRelease,
    type TrackFingerprints,
} from '../src/core/track-release-plan.js';

/**
 * A TRACK RELEASES ONLY WHEN IT CHANGED (Tynn #1058 L8; the spec's slice 8). One approved tag, `tracks-v<build>` (stable)
 * or `tracks-dev-v<build>` (dev), builds every track at that build; each track's fingerprint is compared with the one its
 * last PUBLISHED release carries, and only the tracks that differ get a draft. The owner's rules ride on top: a host
 * update always comes with its client UI (2026-11-26), and the browser runs on the client build its manifest names, so a
 * new client brings a new browser. What is unknown (no release yet, no fingerprint to read) is CHANGED: the failure
 * direction is a release nobody needed, never a change nobody shipped.
 */
const fp = (over: Partial<TrackFingerprints> = {}): TrackFingerprints => ({ client: 'c1', browser: 'b1', host: 'h1', launcher: 'l1', ...over });
const same = { client: 'c1', browser: 'b1', host: 'h1', launcher: 'l1' };

describe('the round tag', () => {
    it('names a build and a channel: tracks-v<build> is stable, tracks-dev-v<build> is dev', () => {
        expect(parseRoundTag('tracks-v2026.11.28-1')).toEqual({ build: '2026.11.28-1', channel: 'stable' });
        expect(parseRoundTag('tracks-dev-v2026.11.28-2')).toEqual({ build: '2026.11.28-2', channel: 'dev' });
        expect(parseRoundTag('tracks-v2026.11.28-1.1')).toEqual({ build: '2026.11.28-1.1', channel: 'stable' });
    });

    it('refuses anything else: the app tags, a track\'s own tag, a build that is not a real date', () => {
        for (const t of ['v2.0.0', 'v2.0.0-beta.67', 'client-v2026.11.28-1', 'tracks-v2.0.0', 'tracks-v2026.02.30-1', 'tracks-v2026.11.28-0', 'tracks-beta-v2026.11.28-1', 'tracks-v2026.11.28-1+x']) {
            expect(parseRoundTag(t), t).toBeNull();
        }
    });
});

describe('tracksToRelease', () => {
    it('nothing changed: nothing is released (POSITIVE CONTROL for every case below)', () => {
        expect(tracksToRelease(fp(), same).release).toEqual([]);
    });

    it('the launcher alone changed: the launcher alone', () => {
        const r = tracksToRelease(fp({ launcher: 'l2' }), same);
        expect(r.release).toEqual(['launcher']);
        expect(r.why.launcher).toMatch(/changed/);
        expect(r.why.client).toMatch(/unchanged/);
    });

    it('the client changed: the client and the browser that runs on it; the host is left running', () => {
        expect(tracksToRelease(fp({ client: 'c2' }), same).release).toEqual(['client', 'browser']);
    });

    it('the browser changed: it names this build\'s client, so the client is released with it', () => {
        expect(tracksToRelease(fp({ browser: 'b2' }), same).release).toEqual(['client', 'browser']);
    });

    it('the host changed: it always comes with its client UI (the owner, 2026-11-26), and the browser follows the client', () => {
        const r = tracksToRelease(fp({ host: 'h2' }), same);
        expect(r.release).toEqual(['client', 'browser', 'host']);
        expect(r.why.client).toMatch(/host/);
    });

    it('a track never released, or whose fingerprint cannot be read, is CHANGED', () => {
        expect(tracksToRelease(fp(), { ...same, launcher: undefined }).release).toEqual(['launcher']);
        expect(tracksToRelease(fp(), { ...same, launcher: null }).release).toEqual(['launcher']);
        expect(tracksToRelease(fp(), {}).release).toEqual(['launcher', 'client', 'browser', 'host']);
    });
});

describe('lastPublished: what a track is compared with', () => {
    const rel = (tagName: string, isDraft = false, isPrerelease = false) => ({ tagName, isDraft, isPrerelease });
    const releases = [
        rel('v2.0.0-beta.66', false, true),
        rel('client-v2026.11.20-1'),
        rel('client-v2026.11.25-2'),
        rel('client-v2026.11.26-1', true), // a draft nobody published: no install has it
        rel('client-v2026.11.27-1', false, true), // dev only
        rel('host-v2026.11.25-1'),
        rel('client-v2026.11.28-1'), // this round's own build, from a re-run
    ];

    it('is the newest PUBLISHED release of the track before this build, never a draft', () => {
        expect(lastPublished(releases, 'client', 'stable', '2026.11.28-1')).toEqual({ tag: 'client-v2026.11.25-2', build: '2026.11.25-2' });
    });

    it('a dev round compares with what dev installs read: prereleases too', () => {
        expect(lastPublished(releases, 'client', 'dev', '2026.11.28-1')).toEqual({ tag: 'client-v2026.11.27-1', build: '2026.11.27-1' });
    });

    it('a track with no published release has nothing to compare with', () => {
        expect(lastPublished(releases, 'launcher', 'stable', '2026.11.28-1')).toBeNull();
        expect(lastPublished(releases, 'browser', 'dev', '2026.11.28-1')).toBeNull();
    });
});

describe('the fingerprints', () => {
    it('are the same for the same files in any order, and differ for one changed byte or path', () => {
        const a = [{ path: 'dist/main/host.js', sha256: 'a'.repeat(64) }, { path: 'package-lock.json', sha256: 'b'.repeat(64) }];
        expect(fingerprintOf(a)).toBe(fingerprintOf([...a].reverse()));
        expect(fingerprintOf(a)).toMatch(/^[0-9a-f]{64}$/);
        expect(fingerprintOf(a)).not.toBe(fingerprintOf([a[0]!, { path: 'package-lock.json', sha256: 'c'.repeat(64) }]));
        expect(fingerprintOf(a)).not.toBe(fingerprintOf([a[0]!, { path: 'package-lock2.json', sha256: 'b'.repeat(64) }]));
    });

    it('name their release asset beside the packages, outside the stem the launcher reads', () => {
        expect(fingerprintAssetName('host', '2026.11.28-1')).toBe('host-2026.11.28-1.fingerprint.json');
    });

    it('read the relative imports of a built bundle, static and dynamic, and nothing from node_modules', () => {
        const src = `import{a as b}from"./chunks/core-1a2b.js";import x from './y.js';export * from "../shared/z.js";const m=await import("./lazy.js");import "electron";import "node:fs";`;
        expect(importsOf(src).sort()).toEqual(['../shared/z.js', './chunks/core-1a2b.js', './lazy.js', './y.js']);
    });

    it('a chunk only the host reaches is the host\'s; a chunk shared with the window is both', () => {
        const files: Record<string, string> = {
            'dist/main/host.js': `import "./chunks/host-only.js";import "./chunks/shared.js";`,
            'dist/main/main.js': `import "./chunks/shared.js";`,
            'dist/main/chunks/host-only.js': `import "./deep.js";`,
            'dist/main/chunks/deep.js': '',
            'dist/main/chunks/shared.js': '',
        };
        const read = (p: string) => files[p] ?? null;
        expect(hostOnlyFiles('dist/main/host.js', ['dist/main/main.js'], read).sort()).toEqual(['dist/main/chunks/deep.js', 'dist/main/chunks/host-only.js', 'dist/main/host.js']);
    });
});
