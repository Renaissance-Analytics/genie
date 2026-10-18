import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRoute, pickThreadRoute } from '../src/core/route.js';

/**
 * PICKING A CHAT TAB (the owner, 2026-10-14): "When the chat is pinned, whenever I select an agent tab, it should bring me
 * to that agent's view as well." The pinned chat is the only chat now (2026-10-17: "get rid of the chat flyout and make
 * the pinned chat be the only chat ux"), so that is what every pick does.
 */
describe('picking a chat tab', () => {
    it('the main view goes to that agent too, its chat beside it — from wherever the person was', () => {
        expect(parseRoute(pickThreadRoute('a2'))).toMatchObject({ surface: 'agent', agentId: 'a2', tab: 'stream', chat: 'a2' });
        expect(parseRoute(pickThreadRoute('a2')).pin ?? null).toBeNull();
    });
});

describe('the app uses them', () => {
    const strip = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    // Changed for the beta.26 report (chat-follows-workspace.test.tsx): carryChat is handed the roster and the chat's
    // remembered tabs, so arriving at ANOTHER workspace moves the chat to an agent of that workspace.
    it('every navigation carries the open chat, pinned or floating, told the roster and the remembered tabs', () => {
        expect(strip('../src/renderer/App.tsx').match(/onNavigate=\{\(r\)\s*=>\s*navigate\(carryChat\(r,\s*parsed,\s*snapshot\.agents,\s*openedThreads\)\)\}/g) ?? []).toHaveLength(1);
    });
    it('a chat tab is picked through pickThreadRoute', () => {
        expect(strip('../src/renderer/Shell.tsx').match(/onPickThread=\{\(id\)\s*=>\s*onNavigate\(pickThreadRoute\(id\)\)\}/g) ?? []).toHaveLength(1);
    });
});
