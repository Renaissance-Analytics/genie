import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * "LEAVE SAFE MODE" DOES NOTHING (Tynn #1076, beta.66). The banner reads `snapshot.safeMode`, and since Tynn #898 2d-4b this
 * machine's window is served from genie-host's PHONE REGISTRY, which reads `safeMode.view()` only when it is touched. The
 * host's `safeMode.leave()` cleared the state and emitted, but nothing listening touched that registry: no new snapshot
 * went out, so the banner stayed up and the click looked like nothing happened. Read from source: genie-host.ts is the
 * host's composition and cannot be run in a test (the SafeMode and Registry halves have their own tests). Line comments
 * stripped (CRLF-safe), so prose is no wiring.
 */

const strip = (text: string): string => text.split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
const host = strip(readFileSync(new URL('../src/main/genie-host.ts', import.meta.url), 'utf8'));

describe('genie-host: a safe-mode change is pushed to every window (Tynn #1076)', () => {
    it('the phone registry, which serves the window its snapshot, reads safe mode from the host', () => {
        expect(host).toMatch(/phoneRegistry\.setSafeMode\(\(\) => safeMode\.view\(\)\);/);
    });

    it('and is touched whenever safe mode changes, so Leave safe mode takes the banner down', () => {
        expect(host).toMatch(/safeMode\.onChange\(\(\) => \{ phoneRegistry\.touch\(\); \}\);/);
    });
});
