/**
 * Refuse to ship a main bundle that contains the E2E rig.
 *
 * `main/e2e/**` is Playwright rigging: `registerE2EMocks` replaces GitHub IPC with
 * fixtures, `hosting.ts` fakes a hosting backend, and 18 seed modules write fixture
 * workspaces, agents and repos. Until `__GENIE_E2E_BUILD__` existed, all of it was compiled
 * into `app/background.js` and reachable in a shipped installer by setting `GENIE_E2E=1` —
 * measured at ~93 KB of a 3.4 MB bundle, from the bundle's own sourcemap.
 *
 * ## Why this is a build step and not a unit test
 *
 * `scripts/__tests__/main-build-entries.test.ts` asserts the config defines the flag
 * correctly, which is a claim about OUR code. Whether rolldown then removes the dead branch
 * and everything it reached is a claim about THE BUNDLER — and this build sets
 * `codeSplitting: false`, which otherwise inlines dynamic imports. A bundler upgrade could
 * change that silently, in the direction nobody is watching: the app still builds, still
 * starts, and quietly carries the mocks again.
 *
 * So the artifact is the thing checked, with the artifact's own sourcemap as evidence.
 *
 * ## Why `sources`, not a grep
 *
 * The bundle is one minified line and its sourcemap embeds `sourcesContent` — the ORIGINAL
 * text of every included file. Grepping either one for `main/e2e` matches background.ts's
 * own source text wherever it mentions the path, so a grep reports a hit for code that was
 * correctly removed. Measured: during development a probe module was absent from `sources`
 * (index -1) while `grep -c` on the map still answered 1. `sources` is the list of files
 * that actually contributed; that is the question worth asking.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Source paths that must never appear in a production main bundle. */
const FORBIDDEN = [
    { dir: 'main/e2e/', what: 'the E2E rig (mocks, fixtures, seeds)' },
];

/**
 * The ONE file under `main/e2e/` a production bundle may contain.
 *
 * `flags.ts` is the seam, not the rig: production code asks `isE2E()` in a few places
 * (`detachedEnabled: … && !isE2E()`, the boot capability check, the mobile server), and
 * those predicates have to come from somewhere. It imports nothing and is a handful of
 * env reads that fold to `false` once `__GENIE_E2E_BUILD__` is defined false.
 *
 * Allowing it by name is only safe while that stays true — a single import added to
 * `flags.ts` would drag whatever it imported into every shipped build, through the one hole
 * this guard deliberately leaves. So the allowance is not taken on trust: `assertSeamIsInert`
 * reads the file and fails if it imports anything at all.
 */
const SEAM = 'main/e2e/flags.ts';

/** Fail if the one allowed file could smuggle the rig back in. */
function assertSeamIsInert(repoRoot) {
    const seamPath = path.join(repoRoot, SEAM);
    if (!fs.existsSync(seamPath)) {
        console.error(`assert-no-e2e-in-bundle: ${SEAM} is missing — the seam moved or was renamed.`);
        return false;
    }
    const src = fs.readFileSync(seamPath, 'utf8');
    // Strip comments first: the file's own documentation discusses imports at length, and a
    // guard that matched prose would fail for the wrong reason (genie#517's class of bug).
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const imports = [
        ...code.matchAll(/^\s*import\b[^;]*;/gm),
        ...code.matchAll(/\brequire\s*\(/g),
        ...code.matchAll(/\bawait\s+import\s*\(/g),
    ];
    if (imports.length > 0) {
        console.error(
            `\n${SEAM} must import NOTHING — it is the one file under main/e2e/ allowed into a\n` +
                'production bundle, so anything it pulls in is shipped with it. Found:\n' +
                imports.map((m) => '  ' + m[0].trim()).join('\n') +
                '\n',
        );
        return false;
    }
    return true;
}

function sourcesOf(mapPath) {
    const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    return (map.sources ?? []).map((s) => s.replace(/\\/g, '/'));
}

function main() {
    const appDir = path.resolve(process.argv[2] ?? 'app');
    const maps = fs
        .readdirSync(appDir)
        .filter((f) => f.endsWith('.js.map'))
        .map((f) => path.join(appDir, f));

    if (maps.length === 0) {
        // A missing artifact must FAIL rather than pass for lack of anything to check — the
        // classic way a guard reports success on an empty directory.
        console.error(
            `assert-no-e2e-in-bundle: no *.js.map in ${appDir}. ` +
                'Run `npm run build:main` first — a bundle that was never built cannot be cleared.',
        );
        process.exit(1);
    }

    let bad = 0;
    // Checked first: if the seam is not inert, the per-bundle allowance below is a hole.
    if (!assertSeamIsInert(path.resolve(appDir, '..'))) bad++;
    for (const mapPath of maps) {
        const sources = sourcesOf(mapPath);
        if (sources.length === 0) {
            console.error(`${path.basename(mapPath)}: sourcemap lists no sources — cannot verify.`);
            bad++;
            continue;
        }
        for (const { dir, what } of FORBIDDEN) {
            // `sources` entries are relative to the bundle, so match on the tail.
            const hits = sources.filter((s) => s.includes(dir) && !s.endsWith(SEAM));
            if (hits.length > 0) {
                bad++;
                console.error(
                    `\n${path.basename(mapPath, '.map')} contains ${what} — ${hits.length} file(s):`,
                );
                for (const h of hits.slice(0, 10)) {
                    console.error('  ' + h.replace(/^.*?(main\/)/, '$1'));
                }
                if (hits.length > 10) console.error(`  … and ${hits.length - 10} more`);
            }
        }
    }

    if (bad > 0) {
        console.error(
            '\nThis build was made with __GENIE_E2E_BUILD__ true, or the dead branch guarding\n' +
                'the rig stopped being dead. Production builds go through `npm run build:main`;\n' +
                'only `build:e2e` passes --e2e.\n',
        );
        process.exit(1);
    }
    console.log(`assert-no-e2e-in-bundle: ${maps.length} bundle(s) clear of the E2E rig.`);
}

main();
