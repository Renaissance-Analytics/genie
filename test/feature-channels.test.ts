import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FEATURE_CHANNELS, NO_FEATURES } from '../src/renderer/bridge.js';
import { EMPTY_FEATURES } from '../src/renderer/features.js';

/**
 * THE FEATURE BRIDGE CONTRACT — the renderer's `features` section of `GenieBridge`, the preload's
 * channels and the main process's handlers name the same three channels from ONE constant. Two
 * copies of a channel name is how a renderer invokes a channel nobody answers, silently, forever.
 */

describe('channels', () => {
    it('are three, named once, and both halves import the constant rather than retyping the strings', () => {
        // Five since the attachments picker (§6.4): the host's own file dialog, never a typed path.
        expect(FEATURE_CHANNELS).toEqual({ snapshot: 'genie:features-snapshot', act: 'genie:features-act', changed: 'genie:features-changed', browserBounds: 'genie:features-browser-bounds', pickFiles: 'genie:features-pick-files' });
        const preload = readFileSync(new URL('../src/main/preload.ts', import.meta.url), 'utf8');
        const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
        for (const src of [preload, main]) {
            expect(src).toContain('FEATURE_CHANNELS');
            // COUNTED: zero retyped literals. One would be a second source of truth.
            expect(src.match(/'genie:features-/g) ?? []).toHaveLength(0);
        }
    });
});

describe('the bridge’s default', () => {
    it('NO_FEATURES answers the first-paint state and refuses actions honestly when there is no main process', async () => {
        expect(await NO_FEATURES.snapshot()).toEqual(EMPTY_FEATURES);
        await expect(NO_FEATURES.act({ kind: 'knowledge.search', query: 'x' })).rejects.toThrow(/no main process/);
        const off = NO_FEATURES.subscribe(() => {});
        expect(typeof off).toBe('function');
    });
});

describe('the browser box', () => {
    it('is a fourth channel, named once, and NO_FEATURES accepts bounds silently (there is no view to place)', async () => {
        expect(FEATURE_CHANNELS.browserBounds).toBe('genie:features-browser-bounds');
        const preload = readFileSync(new URL('../src/main/preload.ts', import.meta.url), 'utf8');
        expect(preload).toContain('FEATURE_CHANNELS.browserBounds');
        await expect(NO_FEATURES.setBrowserBounds({ x: 0, y: 0, width: 1, height: 1 })).resolves.toBeUndefined();
    });
});
