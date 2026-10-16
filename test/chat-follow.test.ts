import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRoute, pickThreadRoute } from '../src/core/route.js';

/**
 * PICKING A CHAT TAB (the owner, 2026-10-14): "When the chat is pinned, whenever I select an agent tab, it should bring me
 * to that agent's view as well. When in flyout mode and it's floating I can free roam anywhere in the app and it remains
 * open to the same agent chat until I close the flyout or pin it again."
 */
describe('picking a chat tab', () => {
    it('PINNED: the main view goes to that agent too, its chat pinned beside it', () => {
        const current = parseRoute('genie://dashboard?group=workspace&chat=a1&pin=right');
        const next = parseRoute(pickThreadRoute(current, 'a2', true));
        expect(next).toMatchObject({ surface: 'agent', agentId: 'a2', tab: 'stream', chat: 'a2', pin: 'right' });
    });

    it('FLOATING: only the conversation switches; the view stays where the person is roaming', () => {
        const current = parseRoute('genie://workspace/tynn?chat=a1');
        const next = parseRoute(pickThreadRoute(current, 'a2', false));
        expect(next).toMatchObject({ surface: 'workspace', chat: 'a2' });
        expect(next.pin ?? null).toBeNull();
    });
});

describe('the app uses them', () => {
    const strip = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    // Changed for the beta.26 report (chat-follows-workspace.test.tsx): carryChat is handed the roster and the chat's
    // remembered tabs, so arriving at ANOTHER workspace moves the chat to an agent of that workspace.
    it('every navigation carries the open chat, pinned or floating, told the roster and the remembered tabs', () => {
        expect(strip('../src/renderer/App.tsx').match(/onNavigate=\{\(r\)\s*=>\s*navigate\(carryChat\(r,\s*parsed,\s*snapshot\.agents,\s*openedThreads\)\)\}/g) ?? []).toHaveLength(1);
    });
    it('a chat tab is picked through pickThreadRoute, told whether the chat is pinned', () => {
        expect(strip('../src/renderer/Shell.tsx').match(/onPickThread=\{\(id\)\s*=>\s*onNavigate\(pickThreadRoute\(parsed,\s*id,\s*pinned === 'chat'\)\)\}/g) ?? []).toHaveLength(1);
    });
});
