import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALERT_KINDS, SOUND_GROUPS, alertSound } from '../src/core/alerts.js';
import { issueWatchSoundKinds, type IwEvent } from '../src/core/issue-watch.js';

/**
 * A SOUND FOR WHAT GITHUB DOES (Tynn #766 meets #806; the owner: "Every kind of action an agent can take needs to have a
 * sound setting" — and IssueWatch brings GitHub into Genie). Four rows under "GitHub": a new issue, a new pull request,
 * a new security alert, a CI run failing — None until chosen (Genie 1's rule for every new row: an upgrade adds no
 * noise). What needs you knocks (security, CI failed); the rest rise. One sound per kind per batch, however many items
 * arrived together.
 */
const ev = (kind: IwEvent['kind']): IwEvent => ({ kind });

describe('the rows', () => {
    it('four GitHub rows, None until chosen, each playing once chosen', () => {
        expect(SOUND_GROUPS.find((g) => g.group === 'github')?.label).toBe('GitHub');
        const rows = ALERT_KINDS.filter((k) => k.group === 'github');
        expect(rows.map((k) => k.kind)).toEqual(['ghissue', 'ghpr', 'ghsecurity', 'ghci']);
        for (const r of rows) {
            expect(alertSound(r.kind, { notification_sounds: true }), r.kind).toBeNull();
            expect(alertSound(r.kind, { notification_sounds: true, [`sound_${r.kind}`]: 'sparkle' }), r.kind).toEqual({ kind: 'wav', file: 'sparkle.wav' });
        }
        expect(Object.fromEntries(rows.map((r) => [r.kind, r.motif]))).toEqual({ ghissue: 'done', ghpr: 'done', ghsecurity: 'attention', ghci: 'attention' });
        expect(ALERT_KINDS).toHaveLength(26);
    });
});

describe('which sound an IssueWatch batch plays', () => {
    it('one per kind per batch — COUNTED; a change, a close, a comment, a CI pass plays nothing', () => {
        expect(issueWatchSoundKinds([ev('pr.new'), ev('pr.new'), ev('security.new'), ev('issue.new'), ev('ci.failed'), ev('ci.failed')])).toEqual(['ghpr', 'ghsecurity', 'ghissue', 'ghci']);
        expect(issueWatchSoundKinds([ev('issue.updated'), ev('closed'), ev('comment'), ev('ci.passed'), ev('review'), ev('push')])).toEqual([]);
    });

    it('main plays them for every batch Tynn sends, as a genie:action the window plays by its row', () => {
        const src = readFileSync('src/main/main.ts', 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
        expect(src).toMatch(/for \(const kind of issueWatchSoundKinds\(events\)\) broadcast\('genie:action', \{ agentId: null, kind \}\);/);
    });
});
