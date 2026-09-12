import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE PHONE'S PUSH CHANNEL, CHECKED AT BOTH ENDS.
 *
 * A wrong push name does not throw. The host emits, nobody is listening, and the
 * screen simply never refreshes — no error, no failed call, nothing in a log.
 * `main/__tests__/flow-ipc-channels.test.ts` already makes this argument for the
 * Electron IPC surface; the phone has the same hazard and had no such guard.
 *
 * It had the bug, too, and the host knew: `main/mobile/server.ts` carries a
 * comment saying the name MUST be `questions:changed` (plural) because "the old
 * singular `question:changed` matched NOTHING, so the badge never moved". The
 * HOST was fixed. The phone was left listening for the singular, so every
 * question push has been landing on a client that ignores it.
 *
 * ## Direction
 *
 * Only one direction is a bug. A listener for a name nobody emits is a DEAD
 * FEATURE — the whole point of this file. The reverse is normal and deliberate:
 * the host emits far more than the phone renders today, and asserting otherwise
 * would fail every time the host grew an event.
 *
 * ## Why strings and not types
 *
 * The two ends are different programs by construction — one runs in Electron
 * main, the other in a browser on someone's phone, and they share no module. A
 * shared union would be better and does not exist; comparing the literals is
 * what can be done today, and it is what would have caught this.
 */

const REPO = path.join(__dirname, '..', '..', '..');

/** Read a file, or '' when it is not there (so a rename fails loudly below). */
const read = (rel: string): string => {
    const file = path.join(REPO, rel);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
};

/** Every event name the HOST pushes to phones — both emit helpers. */
function emitted(): Set<string> {
    const names = new Set<string>();
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== '__tests__' && entry.name !== 'node_modules') walk(full);
                continue;
            }
            if (!entry.name.endsWith('.ts')) continue;
            const src = fs.readFileSync(full, 'utf8');
            // `mobileEmit` AND `mobileEmitEach` — missing the second variant is
            // how a first pass at this file wrongly called `control:changed`
            // dead, which it is not: baton.ts emits it with `mobileEmitEach`.
            for (const m of src.matchAll(/mobileEmit(?:Each)?\(\s*'([^']+)'/g)) {
                names.add(m[1] as string);
            }
        }
    };
    walk(path.join(REPO, 'main'));
    return names;
}

/** Every event name the PHONE reacts to. */
function listenedFor(): Map<string, string[]> {
    const sources = [
        'renderer/pages/mobile.tsx',
        ...fs
            .readdirSync(path.join(REPO, 'renderer', 'components', 'Mobile'))
            .filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
            .map((f) => path.join('renderer', 'components', 'Mobile', f)),
    ];
    const found = new Map<string, string[]>();
    for (const rel of sources) {
        for (const m of read(rel).matchAll(/e\.type\s*(?:===|!==)\s*'([^']+)'/g)) {
            const name = m[1] as string;
            found.set(name, [...(found.get(name) ?? []), rel]);
        }
    }
    return found;
}

describe('the phone listens for names the host actually pushes', () => {
    it('POSITIVE CONTROL — both ends were actually read', () => {
        // Without this, a moved file or a changed helper name turns the real
        // assertion into "no listeners, nothing to check", which passes.
        const push = emitted();
        const listen = listenedFor();
        expect(push.size).toBeGreaterThan(10);
        expect(listen.size).toBeGreaterThan(2);
        // The two that pin the extraction itself: one per emit helper.
        expect(push.has('questions:changed')).toBe(true); // mobileEmit
        expect(push.has('control:changed')).toBe(true); // mobileEmitEach
    });

    it('has no listener for an event nothing emits', () => {
        const push = emitted();
        const dead = [...listenedFor()]
            .filter(([name]) => !push.has(name))
            .map(([name, files]) => `${name} (listened for in ${files.join(', ')})`);

        expect(
            dead,
            'a listener nothing emits is a silently dead feature — the push lands and the screen never refreshes',
        ).toEqual([]);
    });
});
