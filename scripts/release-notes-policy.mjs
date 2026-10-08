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
/**
 * Does this tag have curated notes, and if not, what IS in the directory?
 *
 * `release.yml` already fails correctly when `docs/releases/<tag>.md` is missing — in
 * `prepare-release`, which gates the platform builds through `needs:`, so nothing is built or
 * published and the dispatch fails in about twenty seconds. The ordering is right.
 *
 * What it never said is what exists instead, and that is the entire cost of the failure. "Missing
 * docs/releases/v0.7.0-beta.343.md" sends somebody to the repo to look; "the directory has
 * v2.0.0-beta.1.md" tells them the answer is a rename.
 *
 * Not hypothetical: `docs/releases/` currently holds `v2.0.0-beta.1.md`, a version nobody has
 * committed to, while `package.json` is `0.7.0-beta.342` and every tag is `v0.7.0-beta.*`. Whichever
 * scheme is chosen, one of them needs renaming first, and the only thing preventing a failed dispatch
 * today is remembering a sentence in a PR body.
 *
 * It REPORTS and does not guess. Choosing the version is the owner's call; a helper that confidently
 * renamed to the wrong tag would be worse than the message it replaced.
 *
 * Pure, taking the listing as an argument, so the wording is testable without a release.
 */
export function notesVerdict(tag, available = []) {
    const clean = typeof tag === 'string' ? tag.trim().replace(/^v/i, '') : '';
    if (!clean) {
        return { ok: false, message: 'No tag given, so no release notes can be looked up.' };
    }
    const wanted = `v${clean}.md`;
    const notes = available.filter((f) => typeof f === 'string' && f.toLowerCase().endsWith('.md'));
    if (notes.includes(wanted)) {
        return { ok: true, message: `Found curated release notes: docs/releases/${wanted}` };
    }
    if (notes.length === 0) {
        return {
            ok: false,
            message: `No release notes at all in docs/releases/ — ${wanted} is required before tagging.`,
        };
    }
    /**
     * CAPPED, and the first version of this was not: it listed all 68 files in the real directory.
     * A wall of filenames is as unhelpful as no listing, and it is the exact failure the policy in
     * this same module exists to prevent — the owner's complaint there being *"people don't want to
     * read novels."* Committed by the tool that enforces it.
     *
     * Newest LAST, because that is where a reader's eye lands and where the answer usually is. The
     * odd-major file is named separately: sorting alone either buries it or over-promotes it, and
     * "there is a v2.x file among your v0.7.x ones" is the sentence that actually helps.
     */
    const SHOW = 5;
    const sorted = [...notes].sort((a, b) => compareVersions(a.replace(/\.md$/i, ''), b.replace(/\.md$/i, '')));
    const shown = sorted.slice(-SHOW);
    const hidden = sorted.length - shown.length;
    const major = (f) => f.replace(/^v/i, '').split('.')[0];
    const oddMajor = sorted.filter((f) => major(f) !== major(wanted));

    const lines = [
        `Missing curated release notes: docs/releases/${wanted}`,
        `  newest present: ${shown.join(', ')}${hidden > 0 ? ` (and ${hidden} more)` : ''}`,
    ];
    if (oddMajor.length > 0) {
        lines.push(
            `  NOTE: ${oddMajor.join(', ')} ${oddMajor.length === 1 ? 'is' : 'are'} from a different major`
                + ` than the tag — most likely this release's notes under the wrong version.`,
        );
    }
    lines.push(
        `  If one of those holds this release's notes, RENAME it to ${wanted}.`,
        '  The file name must match the tag EXACTLY — release.yml reads it by name.',
    );
    return { ok: false, message: lines.join('\n') };
}

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
