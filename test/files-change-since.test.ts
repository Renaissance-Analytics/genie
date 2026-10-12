import { describe, expect, it } from 'vitest';
import { countsAsDiskChange } from '../src/core/files-panel.js';

/**
 * A DISK CHANGE IS ONE THAT HAPPENED AFTER THE WATCH STARTED. The release run of v2.0.0-beta.5 (2026-10-11,
 * macOS runner) failed `files-host.test.ts`: README.md — written in the test's set-up, BEFORE `watch()` —
 * came back as `unreported`. FSEvents replays events for writes made shortly before the watcher was
 * attached; Linux's inotify does not, which is why no Linux run ever saw it. The host used to treat every
 * watcher event as a change; the rule is now a pure function of the file's mtime and the watch start:
 * older than the watch → not a change; at or after → a change; a path that no longer exists → a deletion,
 * which is a change; a directory → never (Windows reports parent directories of a written file).
 */
describe('countsAsDiskChange', () => {
    const since = 1_760_000_000_000;

    it('a write that predates the watch is NOT a change — FSEvents replaying it must not mark the file', () => {
        expect(countsAsDiskChange({ mtimeMs: since - 1, isDirectory: false }, since)).toBe(false);
        expect(countsAsDiskChange({ mtimeMs: since - 5_000, isDirectory: false }, since)).toBe(false);
    });

    it('a write at or after the watch start IS a change', () => {
        expect(countsAsDiskChange({ mtimeMs: since, isDirectory: false }, since)).toBe(true);
        expect(countsAsDiskChange({ mtimeMs: since + 1, isDirectory: false }, since)).toBe(true);
    });

    it('a path that no longer exists is a deletion, which is a change regardless of time', () => {
        expect(countsAsDiskChange(null, since)).toBe(true);
    });

    it('a directory is never a change, whatever its mtime', () => {
        expect(countsAsDiskChange({ mtimeMs: since + 10, isDirectory: true }, since)).toBe(false);
    });
});
