import path from 'node:path';
import type { Configuration } from 'app-builder-lib';
import { getConfig } from 'app-builder-lib/out/util/config/config';
import { minimatch } from 'minimatch';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The MCP shuttle bundle ships OUTSIDE app.asar (genie#346).
 *
 * The shuttle runs on the shipped standalone Node, not Electron — that is what
 * lets it outlive an upgrade. Only Electron can read inside `app.asar`; plain Node
 * sees an archive file, and `node <resources>/app.asar/app/mcp-shuttle.js` fails
 * with "Cannot find module". A packaged Genie would then fall back in-process on
 * every boot, the shuttle would never run for a single user, and nothing would say
 * why. So the bundle is unpacked, the way the pty-host package already is.
 *
 * Read through the INSTALLED app-builder-lib's loader, so this is the effective
 * config rather than a re-parse of the YAML.
 */

const root = path.resolve(__dirname, '..', '..');
let config: Configuration;

beforeAll(async () => {
    config = await getConfig(root, null, null);
});

const unpacked = (file: string): boolean => {
    const patterns = ([] as string[]).concat((config.asarUnpack as string[] | string | null | undefined) ?? []);
    return patterns.some((pattern) => minimatch(file, pattern, { dot: true }));
};

describe('the shuttle bundle is readable by plain Node', () => {
    it('unpacks app/mcp-shuttle.js from the asar', () => {
        expect(unpacked('app/mcp-shuttle.js')).toBe(true);
    });

    it('POSITIVE CONTROL: the matcher reads the real asarUnpack list', () => {
        // Otherwise "unpacked" could be true of a matcher that matches anything.
        expect(unpacked('node_modules/node-pty/lib/index.js')).toBe(true);
        expect(unpacked('app/background.js')).toBe(false);
    });
});
