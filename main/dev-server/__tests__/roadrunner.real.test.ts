import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROADRUNNER_VERSION, roadrunnerAssetFor } from '../roadrunner';
import { ensureRoadrunner } from '../roadrunner-install';

/**
 * REAL: Genie's RoadRunner install against the real release (genie#668).
 *
 * The unit tests pin the URL, the archive layout and the version banner as they
 * were read off v2025.1.15. Only the real release can say they are still true:
 * that the URL answers, that the archive holds `rr` where Genie looks, and that
 * the binary reports the pinned version in a shape the parser reads. Runs on the
 * Linux hosting lane and the Windows one (hosting-windows.yml), so both archive
 * kinds and both banner spellings are exercised.
 *
 * The effects here are the platform's own tools — the same `tar`,
 * `Expand-Archive` and `unzip` Genie's installer uses — driven through the real
 * `ensureRoadrunner`.
 */

const asset = roadrunnerAssetFor({ os: process.platform, arch: process.arch });
const work = mkdtempSync(path.join(tmpdir(), 'genie-real-rr-'));

afterAll(() => {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function fetchWithRetry(url: string): Promise<Buffer> {
    let last = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(url);
            if (res.ok) return Buffer.from(await res.arrayBuffer());
            last = `HTTP ${res.status}`;
        } catch (e) {
            last = String(e);
        }
        await new Promise((r) => setTimeout(r, attempt * 2000));
    }
    throw new Error(`${url}: ${last}`);
}

describe.skipIf(!asset)('REAL RoadRunner — the release Genie installs for Octane', () => {
    it(`installs ${ROADRUNNER_VERSION} and the binary says so`, async () => {
        const dir = path.join(work, 'roadrunner', ROADRUNNER_VERSION);
        const res = await ensureRoadrunner({
            dir,
            platform: process.platform,
            arch: process.arch,
            effects: {
                exists: (file) => existsSync(file),
                async download(url) {
                    try {
                        const file = path.join(work, path.basename(url));
                        writeFileSync(file, await fetchWithRetry(url));
                        return { ok: true, path: file };
                    } catch (e) {
                        return { ok: false, error: String(e) };
                    }
                },
                async extract(archive, artifact, dest) {
                    mkdirSync(dest, { recursive: true });
                    const cmd =
                        artifact === 'tar.gz'
                            ? spawnSync('tar', ['-xzf', archive, '-C', dest], { encoding: 'utf8' })
                            : process.platform === 'win32'
                              ? spawnSync(
                                    'powershell',
                                    ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dest}' -Force`],
                                    { encoding: 'utf8' },
                                )
                              : spawnSync('unzip', ['-q', '-o', archive, '-d', dest], { encoding: 'utf8' });
                    return cmd.status === 0 ? { ok: true } : { ok: false, error: cmd.stderr || `exit ${cmd.status}` };
                },
                async makeExecutable(file) {
                    chmodSync(file, 0o755);
                },
                async version(exe) {
                    const v = spawnSync(exe, ['--version'], { encoding: 'utf8' });
                    if (v.status !== 0) throw new Error(v.stderr || `exit ${v.status}`);
                    return v.stdout;
                },
                async removeDir(d) {
                    rmSync(d, { recursive: true, force: true });
                },
            },
        });

        expect(res, res.ok ? '' : res.error).toMatchObject({ ok: true });
        if (!res.ok) return;
        expect(res.exe).toBe(path.join(dir, asset!.dir, asset!.exe));
        expect(existsSync(res.exe)).toBe(true);
    }, 180_000);
});
