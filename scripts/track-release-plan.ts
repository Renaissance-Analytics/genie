/**
 * WHICH TRACKS A ROUND RELEASES (Tynn #1058 L8): release.yml's `tracks-guard` runs it after `npm run build`, from the root
 * of the round's checkout. What a fingerprint covers and the rules are src/core/track-release-plan.ts's.
 *
 *   npx tsx scripts/track-release-plan.ts fingerprints --out <file.json>
 *       every track's fingerprint, from the built dist/ and the sources named there
 *   npx tsx scripts/track-release-plan.ts plan --tag <tracks-v<build>|tracks-dev-v<build>> --fingerprints <file.json> \
 *        --releases <releases.json> [--github-output <file>]
 *       releases.json = `gh release list --json tagName,isDraft,isPrerelease --limit 1000`; each track's last published
 *       release's fingerprint is read with `gh release download` (GH_TOKEN). Prints the plan, writes it to plan.json, and
 *       to the GitHub output: build, channel, tracks (space-separated, in release order; empty when nothing changed).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PACKAGE_TRACKS, type PackageTrack } from '../src/core/track-manifest.js';
import {
    fingerprintAssetName, fingerprintOf, hostOnlyFiles, lastPublished, parseRoundTag, tracksToRelease, type ReleaseListing, type TrackFingerprints,
} from '../src/core/track-release-plan.js';
import { BROWSER_JSON } from './track-packages.mjs';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const posix = (p: string) => p.replace(/\\/g, '/');

function walk(dir: string, skip: (rel: string) => boolean = () => false): string[] {
    const out: string[] = [];
    const go = (d: string) => {
        for (const name of readdirSync(d)) {
            const p = join(d, name);
            const rel = posix(relative('.', p));
            if (skip(rel)) continue;
            if (statSync(p).isDirectory()) go(p);
            else out.push(rel);
        }
    };
    if (existsSync(dir)) go(dir);
    return out;
}

const entry = (path: string) => ({ path, sha256: sha(readFileSync(path)) });

function fingerprints(): TrackFingerprints {
    if (!existsSync('dist/main/host.js')) throw new Error('dist/main/host.js is not built: npm run build first');
    const dist = walk('dist');
    const read = (p: string) => (existsSync(p) && statSync(p).isFile() ? readFileSync(p, 'utf8') : null);
    const mainEntries = dist.filter((p) => /^dist\/main\/[^/]+\.js$/.test(p) && p !== 'dist/main/host.js');
    const hostOnly = new Set(hostOnlyFiles('dist/main/host.js', mainEntries, read));
    const shared = ['package.json', 'package-lock.json', 'scripts/track-packages.mjs', 'scripts/build-track-packages.mjs'];
    const client = [...dist.filter((p) => !hostOnly.has(p)), ...shared, 'electron-builder.yml', 'scripts/after-pack.cjs', ...walk('build')];
    const host = [...hostOnly, ...shared, 'scripts/fetch-caddy.ts', 'src/core/engine-protocol.ts'];
    const launcher = walk('native/launcher', (rel) => /^native\/launcher\/target[^/]*$/.test(rel)).concat('build/tray-icon.png');
    return {
        client: fingerprintOf(client.filter((p) => existsSync(p)).map(entry)),
        host: fingerprintOf(host.filter((p) => existsSync(p)).map(entry)),
        browser: fingerprintOf([{ path: 'browser.json', sha256: sha(`${JSON.stringify(BROWSER_JSON)}\n`) }]),
        launcher: fingerprintOf(launcher.map(entry)),
    };
}

/** A published release's fingerprint, or null when it has none that reads (that track is then CHANGED). */
function publishedFingerprint(tag: string, track: PackageTrack, build: string): string | null {
    const name = fingerprintAssetName(track, build);
    const r = spawnSync('gh', ['release', 'download', tag, '--repo', process.env.GITHUB_REPOSITORY ?? '', '--pattern', name, '--output', '-'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    try {
        const v = JSON.parse(r.stdout) as { track?: unknown; build?: unknown; fingerprint?: unknown };
        return v.track === track && v.build === build && typeof v.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(v.fingerprint) ? v.fingerprint : null;
    } catch {
        return null;
    }
}

function arg(argv: string[], name: string): string | undefined {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv: string[]): number {
    const cmd = argv[0];
    if (cmd === 'fingerprints') {
        const out = arg(argv, 'out');
        if (!out) throw new Error('--out is required');
        const fp = fingerprints();
        writeFileSync(out, `${JSON.stringify(fp, null, 2)}\n`);
        for (const t of PACKAGE_TRACKS) console.log(`${t}: ${fp[t]}`);
        return 0;
    }
    if (cmd === 'plan') {
        const tag = arg(argv, 'tag') ?? '';
        const round = parseRoundTag(tag);
        if (!round) {
            console.log(`::error::${tag} is not a round tag: tracks-v<build> (stable) or tracks-dev-v<build> (dev), with a track build such as 2026.11.28-1`);
            return 1;
        }
        const now = JSON.parse(readFileSync(arg(argv, 'fingerprints') ?? '', 'utf8')) as TrackFingerprints;
        const releases = JSON.parse(readFileSync(arg(argv, 'releases') ?? '', 'utf8')) as ReleaseListing[];
        const last: Partial<Record<PackageTrack, string | null>> = {};
        const compared: Record<string, string> = {};
        for (const t of PACKAGE_TRACKS) {
            const prev = lastPublished(releases, t, round.channel, round.build);
            compared[t] = prev ? prev.tag : '(none published)';
            last[t] = prev ? publishedFingerprint(prev.tag, t, prev.build) : null;
        }
        const plan = tracksToRelease(now, last);
        for (const t of PACKAGE_TRACKS) console.log(`${t}: ${plan.release.includes(t) ? 'RELEASE' : 'skip'} (${plan.why[t]}; compared with ${compared[t]})`);
        writeFileSync('plan.json', `${JSON.stringify({ tag, ...round, ...plan, compared, fingerprints: now }, null, 2)}\n`);
        const gh = arg(argv, 'github-output');
        if (gh) appendFileSync(gh, `build=${round.build}\nchannel=${round.channel}\ntracks=${plan.release.join(' ')}\n`);
        if (plan.release.length === 0) console.log(`${tag}: no track changed since its last published release; nothing is drafted`);
        return 0;
    }
    console.log('usage: track-release-plan.ts fingerprints --out <file> | plan --tag <tag> --fingerprints <file> --releases <file> [--github-output <file>]');
    return 2;
}

try {
    process.exit(main(process.argv.slice(2)));
} catch (e) {
    console.log(`::error::track-release-plan: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
}
