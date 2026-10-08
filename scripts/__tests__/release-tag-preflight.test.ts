import { describe, expect, it } from 'vitest';
import { notesVerdict } from '../release-notes-policy.mjs';

/**
 * A TAG WITH NO NOTES FAILS THE RELEASE — make that findable BEFORE the tag is pushed.
 *
 * `release.yml`'s `prepare-release` reads `docs/releases/${GITHUB_REF_NAME}.md` and exits 1 when it
 * is absent. That ordering is already right: the job gates the three platform builds through
 * `needs:`, so nothing is built, published or half-released — the dispatch just fails in about
 * twenty seconds.
 *
 * What it does NOT do is say what exists instead, and that is the whole cost of the failure. The
 * current message is `Missing curated release notes: docs/releases/v0.7.0-beta.343.md`, which tells
 * you the path it wanted and nothing about the path that is there.
 *
 * ## The live instance of this, which is not hypothetical
 *
 * `docs/releases/` holds **`v2.0.0-beta.1.md`** — a version nobody has committed to. `package.json`
 * is `0.7.0-beta.342` and every tag in the repo is `v0.7.0-beta.*`. So whichever scheme the owner
 * picks, one of the two needs a rename first, and the only thing standing between them and a failed
 * dispatch is remembering a sentence in a PR body.
 *
 * Pure, and takes the directory listing as an argument, so the message is asserted without a release
 * and without touching the filesystem.
 */

const available = ['v0.7.0-beta.341.md', 'v0.7.0-beta.342.md', 'v2.0.0-beta.1.md'];

describe('notesVerdict — the tag HAS notes', () => {
    it('is ok, and names the file it found', () => {
        const v = notesVerdict('v0.7.0-beta.342', available);
        expect(v.ok).toBe(true);
        expect(v.message).toContain('v0.7.0-beta.342.md');
    });

    it('accepts a tag given without the leading v, since a human will type it both ways', () => {
        expect(notesVerdict('0.7.0-beta.342', available).ok).toBe(true);
    });
});

describe('notesVerdict — the tag has NO notes', () => {
    const v = notesVerdict('v0.7.0-beta.343', available);

    it('is not ok', () => {
        expect(v.ok).toBe(false);
    });

    it('names the file it WANTED', () => {
        expect(v.message).toContain('v0.7.0-beta.343.md');
    });

    it('LISTS what is actually there, which is the part the workflow never said', () => {
        // The whole point. "Missing docs/releases/v0.7.0-beta.343.md" sends you to the repo;
        // "the directory has v2.0.0-beta.1.md" tells you the answer is a rename.
        expect(v.message).toContain('v2.0.0-beta.1.md');
        expect(v.message).toContain('v0.7.0-beta.342.md');
    });

    it('says the remedy is a RENAME when a plausible candidate exists', () => {
        // A notes file for a different version is almost always the right content under the wrong
        // name — the state this repo is in right now.
        expect(v.message.toLowerCase()).toMatch(/renam/);
    });

    it('does not pretend to know which file is the right one', () => {
        // Choosing the version is the owner's call. The verdict reports; it must not guess, or it
        // becomes a tool that confidently renames to the wrong tag.
        expect(v.message.toLowerCase()).not.toMatch(/\brenaming .* to v0\.7\.0-beta\.343\b/);
    });
});

describe('notesVerdict — edges that would otherwise read as a pass', () => {
    it('an EMPTY directory is not ok, and says so plainly', () => {
        const v = notesVerdict('v1.0.0', []);
        expect(v.ok).toBe(false);
        expect(v.message.toLowerCase()).toContain('no release notes');
    });

    it('a blank or missing tag is not ok', () => {
        // Reached from a shell where `GITHUB_REF_NAME` could be unset. A blank tag matching nothing
        // and reporting ok would be the worst possible answer.
        for (const tag of ['', '   ', undefined]) {
            expect(notesVerdict(tag as never, available).ok, JSON.stringify(tag)).toBe(false);
        }
    });

    it('ignores non-markdown entries rather than counting them as notes', () => {
        expect(notesVerdict('v9.9.9', ['v9.9.9.txt', 'README']).ok).toBe(false);
    });
});

describe('the listing must be READABLE, which the first version was not', () => {
    /**
     * The first implementation listed every file in `docs/releases/` — **68 of them** against the
     * real directory. A wall of filenames is as unhelpful as no listing at all, and it is the exact
     * failure the release-notes policy in this same module exists to prevent: the owner's complaint
     * there was *"people don't want to read novels."* Committed by the tool that enforces it.
     */
    const many = Array.from({ length: 68 }, (_, i) => `v0.7.0-beta.${275 + i}.md`);

    it('shows a handful, not all 68', () => {
        /**
         * Counted on the LISTING LINE, not the whole message — the first version of this assertion
         * counted every filename anywhere in it and failed on a correct implementation, because the
         * wanted file legitimately appears twice (the "missing" line and the rename instruction).
         * An assertion that measures more than its subject reports the wrong thing.
         */
        const v = notesVerdict('v0.7.0-beta.400', many);
        const line = v.message.split(/\r?\n/).find((l) => l.includes('newest present')) ?? '';
        expect((line.match(/\.md/g) ?? []).length).toBeLessThanOrEqual(5);
    });

    it('shows the NEWEST ones, because that is where the answer is', () => {
        const v = notesVerdict('v0.7.0-beta.400', many);
        expect(v.message).toContain('v0.7.0-beta.342.md');
        expect(v.message).not.toContain('v0.7.0-beta.275.md');
    });

    it('says how many it did not show, so the cap is not mistaken for the whole truth', () => {
        const v = notesVerdict('v0.7.0-beta.400', many);
        expect(v.message).toMatch(/\d+ more/);
    });

    it('CALLS OUT a file from a different major, which is the likely rename', () => {
        // The live case: `v2.0.0-beta.1.md` sitting among 68 `v0.7.0-beta.*` files. Sorting by
        // version alone buries or over-promotes it; naming it as the odd one out is what a person
        // actually needs to see.
        const v = notesVerdict('v0.7.0-beta.343', [...many, 'v2.0.0-beta.1.md']);
        expect(v.message).toContain('v2.0.0-beta.1.md');
        expect(v.message.toLowerCase()).toMatch(/different major|another major|does not match/);
    });
});
