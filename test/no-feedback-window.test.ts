import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SETTINGS, carryOverV1 } from '../src/core/settings.js';

/**
 * NO FEEDBACK FEATURE (the owner, 2026-10-18: "drop the feedback feature. It's only issue watch tracked via github
 * issues"). The Feedback window (#951) — Ctrl+Shift+W from anywhere, the tray's "Send feedback…" — is removed with its
 * global key and setting, and Tynn's feedback route was never shipped (#298 closed). What people and agents have to say
 * about the work is GitHub issues, which IssueWatch tracks. Genie 1's global key is reported as dropped, not carried.
 */
describe('the Feedback window is gone', () => {
    it('its modules are gone (COUNTED: four)', () => {
        const gone = ['src/core/feedback.ts', 'src/main/feedback-hotkey.ts', 'src/main/feedback-send.ts', 'src/renderer/components/FeedbackWindow.tsx'];
        expect(gone.filter((f) => existsSync(f))).toEqual([]);
    });

    it('no tray item, no global key, no window route anywhere', () => {
        const strip = (f: string) => readFileSync(f, 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
        expect(strip('src/main/tray.ts')).not.toMatch(/Send feedback/);
        const main = strip('src/main/main.ts');
        expect(main).not.toMatch(/globalShortcut|openFeedback|FEEDBACK_ROUTE|sendFeedback/);
        const app = strip('src/renderer/App.tsx');
        expect(app).not.toMatch(/FeedbackWindow|FEEDBACK_ROUTE|feedback\.open/);
    });

    it('the key’s setting is gone, and Genie 1’s global key is reported as dropped, with why', () => {
        expect(SETTINGS.find((s) => s.key === 'feedback_hotkey')).toBeUndefined();
        const carried = carryOverV1({ global_hotkey: 'Control+Shift+W' });
        expect(carried.applied).toEqual({});
        expect(carried.dropped).toEqual([{ key: 'global_hotkey', reason: expect.stringMatching(/IssueWatch/) }]);
    });
});
