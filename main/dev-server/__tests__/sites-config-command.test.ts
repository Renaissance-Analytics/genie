import { describe, expect, it } from 'vitest';
import {
    effectiveCommand,
    sanitizeDevSitePatch,
    devSiteReconfigureNeedsRestart,
    type DevSiteConfig,
} from '../sites-config';

/**
 * The user-controlled `command` — the heart of the sandbox-serve model. It is the
 * canonical startup argv; `serve` remains a read-only fallback for sites saved
 * before the rework so they keep running until re-saved.
 */
const base = (over: Partial<DevSiteConfig> = {}): DevSiteConfig => ({
    name: 'web',
    genName: 'web.acme.gen',
    repo: 'app',
    runMode: 'command',
    kind: 'http',
    enabled: true,
    ...over,
});

describe('site config — user-controlled command', () => {
    it('keeps a valid command argv and rejects a shell string (no injection)', () => {
        const clean = sanitizeDevSitePatch({
            ...base(),
            command: ['npm', 'run', 'dev'],
        } as DevSiteConfig);
        expect(clean.command).toEqual(['npm', 'run', 'dev']);

        const shelly = sanitizeDevSitePatch({
            ...base(),
            command: 'npm run dev && rm -rf /' as unknown as string[],
        } as DevSiteConfig);
        expect(shelly.command).toBeUndefined(); // not an argv array → dropped
    });

    it('effectiveCommand prefers command, falls back to legacy serve, else null', () => {
        expect(effectiveCommand(base({ command: ['a', 'b'], serve: ['old'] }))).toEqual(['a', 'b']);
        expect(effectiveCommand(base({ serve: ['php', 'artisan', 'serve'] }))).toEqual([
            'php',
            'artisan',
            'serve',
        ]);
        expect(effectiveCommand(base({}))).toBeNull();
        expect(effectiveCommand(base({ command: [] }))).toBeNull(); // empty ⇒ nothing to run
    });

    it('a command change is a restart-worthy reconfigure', () => {
        const before = base({ command: ['npm', 'run', 'dev'] });
        const after = base({ command: ['npm', 'run', 'start'] });
        expect(devSiteReconfigureNeedsRestart(before, after)).toBe(true);
        expect(devSiteReconfigureNeedsRestart(before, base({ command: ['npm', 'run', 'dev'] }))).toBe(
            false,
        );
    });
});
