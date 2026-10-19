import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * EVERY NAVIGATION CARRIES THE OPEN CHAT, onto the agent the view says (`followChat`; the rules themselves are in
 * chat-follows-view.test.tsx). There are no chat tabs to pick from (the owner, 2026-10-18).
 */

describe('the app uses them', () => {
    const strip = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    // Changed for the beta.26 report (chat-follows-workspace.test.tsx): carryChat is handed the roster and the chat's
    // remembered tabs, so arriving at ANOTHER workspace moves the chat to an agent of that workspace.
    it('every navigation carries the open chat, pinned or floating, told the roster and the remembered tabs', () => {
        expect(strip('../src/renderer/App.tsx').match(/onNavigate=\{\(r\)\s*=>\s*navigate\(carryChat\(r,\s*parsed,\s*snapshot\.agents,\s*openedThreads\)\)\}/g) ?? []).toHaveLength(1);
    });
});
