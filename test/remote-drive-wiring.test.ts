import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A DESKTOP WINDOW ON ANOTHER MACHINE DRIVES IT (Tynn #529) — the window half, read from source (App.tsx's hooks are not
 * composed in a test; the behaviour itself is test/remote-bridge.test.ts's `drive`). The owner connected a Pilot's window
 * to a drone and could change nothing: neither of the window's two ways in (a Tynn workstation over the relay, a host by
 * its address) asked for the baton, and nothing on screen offered it. Line comments stripped (CRLF-safe).
 */

const strip = (text: string): string => text.split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
const app = strip(readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8'));
const shell = strip(readFileSync(new URL('../src/renderer/Shell.tsx', import.meta.url), 'utf8'));

describe('the desktop window drives the host it connects to', () => {
    it('both of the desktop window’s connectRemote calls pass `drive: true` (CONTROL: the phone’s call is counted apart)', () => {
        const calls = [...app.matchAll(/connectRemote\(([^;]*)\);/g)].map((m) => m[1]!);
        const desktop = calls.filter((c) => !c.includes("profile: 'mobile'"));
        expect(desktop).toHaveLength(2);
        for (const c of desktop) expect(c).toMatch(/drive: true/);
    });

    it('the remote badge is given Take control, and the window shows the host’s refusals with it', () => {
        expect(app).toMatch(/onTakeControl: \(\) => \{ void remote\.takeControl\(\); \}/);
        expect(shell).toMatch(/<RemoteRefusalBar/);
    });

    it('a Take over the host refused is never dropped: the window says it', () => {
        expect(app).not.toMatch(/onTakeOver=\{\(agentId\) => \{ void resolvedBridge\?\.takeOver\(agentId\); \}\}/);
    });
});
