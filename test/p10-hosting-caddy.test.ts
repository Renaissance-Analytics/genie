import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hostHostingOptions, hostMachinePaths } from '../src/main/hosting-inputs.js';

/**
 * CADDY ON A HOST WITH NO INSTALLER (P10.1d). genie-cloud's container runs genie-host with a resources folder of its own;
 * the front door's Caddy runs only if one is at `GENIE_RESOURCES/runtime/caddy`. When the folder is there and the Caddy is
 * not, Hosting says so, naming the path it looked at — not the installer's "this install has no bundled Caddy", which
 * tells that host's owner nothing about what to put where. (No GENIE_RESOURCES at all is P5a.2's reason, already pinned in
 * p5a2-hosting-writers.test.ts.)
 */

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const temp = async () => { const d = await mkdtemp(join(tmpdir(), 'genie-p10-caddy-')); dirs.push(d); return d; };
const caddyName = process.platform === 'win32' ? 'caddy.exe' : 'caddy';

describe('the front door\'s Caddy, from GENIE_RESOURCES', () => {
    it('a resources folder with no Caddy in it: no Caddy, and the reason names the path it looked at', async () => {
        const home = await temp();
        const resources = await temp();
        const options = await hostHostingOptions(hostMachinePaths({ GENIE_RESOURCES: resources }, home), () => {});
        expect(options.caddyBin).toBeNull();
        expect(options.noCaddyReason).toContain(join(resources, 'runtime', caddyName));
        expect(options.noCaddyReason).toMatch(/https:\/\/<name>\.gen in external browsers is off/);
    });

    it('CONTROL: a Caddy at runtime/caddy runs (from the per-user copy), and there is no reason', async () => {
        const home = await temp();
        const resources = await temp();
        await mkdir(join(resources, 'runtime'), { recursive: true });
        await writeFile(join(resources, 'runtime', caddyName), 'not really caddy');
        const options = await hostHostingOptions(hostMachinePaths({ GENIE_RESOURCES: resources }, home), () => {});
        expect(options.caddyBin).toContain(join(home, 'runtime', 'caddy-bin'));
        expect(options.noCaddyReason).toBeUndefined();
    });

    it('CONTROL: no GENIE_RESOURCES at all keeps P5a.2\'s reason, naming the launch input', async () => {
        const home = await temp();
        const options = await hostHostingOptions(hostMachinePaths({}, home), () => {});
        expect(options.caddyBin).toBeNull();
        expect(options.noCaddyReason).toMatch(/GENIE_RESOURCES/);
    });
});
