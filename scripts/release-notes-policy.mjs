/**
 * Release notes must be SHORT — genie#325.
 *
 * The What's New popover and the upgrade log render `docs/releases/v*.md`
 * verbatim (it becomes the GitHub release body, which `changelog.ts` reads
 * back). Bullets had grown into 400-character paragraphs stacked five deep,
 * and the owner's complaint is exactly that: *"People don't want to read
 * novels."*
 *
 * A limit nobody enforces is a preference. This is the gate — run from
 * `npm test` so it fails at PR time, and again in `release.yml` before the
 * release is created, so a novel cannot reach a user even if the test was
 * skipped.
 *
 * Plain `.mjs`, no dependencies, so the release workflow can run it with a
 * bare `node` before anything is built.
 */

export const RELEASE_NOTES_LIMITS = {
    /** Per bullet, including its `- ` marker. About two lines in the popover —
     *  a bold lede and one sentence. Anything longer is a paragraph wearing a
     *  bullet's clothes. */
    bulletChars: 200,
    /** Across the WHOLE file, both sections. Someone skimming an update
     *  notice reads a handful of lines; past that they close it. */
    bullets: 8,
    /** Many short bullets is still a novel, so the whole thing is capped too. */
    fileChars: 1400,
};

/**
 * The version this rule landed in. Notes published BEFORE it are left alone:
 * their GitHub release bodies are already out, so editing the files would
 * change nothing anyone sees.
 *
 * Derived from the filename rather than a hand-kept exemption list, so it
 * cannot rot and a new file can never quietly opt out — every future version
 * sorts above this one.
 */
export const RELEASE_NOTES_POLICY_FROM = '0.7.0-beta.294';

/** Semver-ish compare, enough for `MAJOR.MINOR.PATCH[-tag.N]` tags. Returns
 *  <0, 0 or >0. A release (no prerelease tag) outranks its own prereleases. */
function compareVersions(a, b) {
    const split = (v) => {
        const [core, pre = ''] = v.replace(/^v/i, '').split('-');
        return [core.split('.').map(Number), pre];
    };
    const [ac, ap] = split(a);
    const [bc, bp] = split(b);
    for (let i = 0; i < 3; i++) {
        const d = (ac[i] ?? 0) - (bc[i] ?? 0);
        if (d) return d;
    }
    if (ap === bp) return 0;
    if (!ap) return 1;
    if (!bp) return -1;
    // `beta.294` vs `beta.30`: compare the trailing number NUMERICALLY, or
    // string order puts 294 below 30 and the newest notes escape the gate.
    const an = ap.match(/^(.*?)\.?(\d+)$/);
    const bn = bp.match(/^(.*?)\.?(\d+)$/);
    if (an && bn && an[1] === bn[1]) return Number(an[2]) - Number(bn[2]);
    return ap < bp ? -1 : 1;
}

/** Whether a `docs/releases/<file>` is covered by the limits. */
export function policyAppliesTo(filename) {
    const m = /^v(.+)\.md$/.exec(filename.split(/[/\\]/).pop());
    if (!m) return false;
    return compareVersions(m[1], RELEASE_NOTES_POLICY_FROM) >= 0;
}

/**
 * What is wrong with these notes, as human-readable lines. Empty means they
 * pass.
 *
 * Every message says the actual number AND the limit, because "too long" with
 * no measurement just sends the author guessing.
 */
export function checkReleaseNotes(text, limits = RELEASE_NOTES_LIMITS) {
    const problems = [];
    const lines = text.split(/\r?\n/);
    const bullets = lines.filter((l) => /^\s*[-*]\s/.test(l)).map((l) => l.trim());

    for (const bullet of bullets) {
        if (bullet.length > limits.bulletChars) {
            const head = bullet.slice(0, 60).replace(/\s+/g, ' ');
            problems.push(
                `bullet is ${bullet.length} characters, over the ${limits.bulletChars} limit — "${head}…"`,
            );
        }
    }

    if (bullets.length > limits.bullets) {
        problems.push(
            `${bullets.length} bullets, over the ${limits.bullets} limit — cut the ones a user would not act on`,
        );
    }

    if (text.length > limits.fileChars) {
        problems.push(
            `${text.length} characters overall, over the ${limits.fileChars} limit`,
        );
    }

    return problems;
}

/**
 * CLI: `node scripts/release-notes-policy.mjs docs/releases/vX.md`
 *
 * Exits non-zero listing what is wrong. Run from `release.yml` BEFORE the
 * GitHub release is created, so a novel cannot reach a user even if the
 * vitest gate was skipped — and so the failure names the file rather than
 * arriving as a red suite three steps away from the cause.
 */
const invokedDirectly =
    process.argv[1] &&
    import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
    const { readFileSync } = await import('node:fs');
    const files = process.argv.slice(2);
    if (files.length === 0) {
        console.error('usage: node scripts/release-notes-policy.mjs <notes.md>...');
        process.exit(2);
    }
    let failed = false;
    for (const file of files) {
        if (!policyAppliesTo(file)) continue;
        const problems = checkReleaseNotes(readFileSync(file, 'utf8'));
        for (const problem of problems) {
            failed = true;
            console.error(`${file}: ${problem}`);
        }
    }
    if (failed) {
        console.error('');
        console.error('Release notes are read in a popover, not a changelog. One line per');
        console.error('change: what a user can now do, or what they must do. Cut the rest.');
        process.exit(1);
    }
}
