import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blockStack, type CpuProfile } from '../src/main/stall-profile.js';

/**
 * WHAT MAIN WAS DOING WHILE IT WAS HELD (beta.53: Windows recorded AppHangTransient for Genie.exe five times on
 * 2026-10-31 — the window's thread not pumping for 5 s+ — and nothing on Genie's side said why). A rolling low-rate
 * sample of main's own stack is read when the watchdog sees a block: the longest run of busy samples at the end of the
 * profile, its heaviest stack. A run of idle samples is not a block; a busy run shorter than asked is not this one.
 */

/** A profile: (root) → main.js run → JSON.stringify (the block), and (idle) around it; one sample per `us`. */
function profile(samples: Array<'idle' | 'stringify' | 'run'>, us = 10_000): CpuProfile {
    const nodes = [
        { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2, 3] },
        { id: 2, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 } },
        { id: 3, callFrame: { functionName: 'flush', url: 'file:///app/dist/main/main.js', lineNumber: 99 }, children: [4] },
        { id: 4, callFrame: { functionName: 'stringify', url: '', lineNumber: -1 } },
    ];
    const id = { idle: 2, run: 3, stringify: 4 } as const;
    return { nodes, startTime: 0, endTime: samples.length * us, samples: samples.map((s) => id[s]), timeDeltas: samples.map(() => us) };
}

describe('the stack of a block', () => {
    it('the longest busy run at the end, at least as long as asked: its heaviest stack, leaf first, and its length', () => {
        const p = profile([...Array(20).fill('idle'), ...Array(30).fill('stringify'), ...Array(10).fill('run'), 'idle']);
        const s = blockStack(p, 300);
        expect(s).not.toBeNull();
        expect(s!.ms).toBe(390);
        expect(s!.stack).toEqual(['stringify', 'flush main.js:100']);
    });

    it('nothing when no busy run is that long (the control: the same profile answers a shorter ask)', () => {
        const p = profile([...Array(5).fill('idle'), ...Array(15).fill('stringify'), ...Array(5).fill('idle')]);
        expect(blockStack(p, 1_000)).toBeNull();
        expect(blockStack(p, 100)).not.toBeNull();
    });

    it('idle is never a block, however long', () => {
        expect(blockStack(profile(Array(500).fill('idle')), 1_000)).toBeNull();
    });

    it('the line it writes is one line, short enough for a log', () => {
        const s = blockStack(profile([...Array(200).fill('stringify')]), 1_000)!;
        expect(s.line).toMatch(/^stall main stack ms=\d+ top=stringify stack=stringify < flush main\.js:100$/);
    });
});

describe('wired into Genie', () => {
    it('main samples itself and reads the sample on a block', () => {
        const main = readFileSync('src/main/main.ts', 'utf8');
        expect(main).toMatch(/startStallProfiler\(/);
    });
});
