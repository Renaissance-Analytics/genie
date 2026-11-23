import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hostingRig, tick, type HostingRig } from './helpers/hosting-rig.js';

/*
 * A HOST THAT BOOTS WITH ITS WORKSPACES ALREADY REGISTERED (genie#1519 in the host split). The real-app trust step relaunches
 * Genie; on Windows that starts a new genie-host on the same home, so the verdicts come from the host's first pass at boot,
 * not from an add or a person's yes. Nobody asks for them: a window's features (features.snapshot, genie-host's HostFeatures
 * since 2g-4d E2b) must still carry each one, and a workspace nobody trusted must still show its step.
 */

let r: HostingRig | null = null;

afterEach(async () => {
    await r?.close();
    r = null;
});

describe('a host booted on a home whose workspaces are registered', () => {
    it('reads each one on its own and a window’s features show it: the untrusted one is listed as a trust step', async () => {
        const home = mkdtempSync(join(tmpdir(), 'trust-host-boot-home-'));
        mkdirSync(join(home, 'runtime'), { recursive: true });
        writeFileSync(join(home, 'runtime', 'workspace-trust.json'), JSON.stringify({ version: 1, carried: [], pendingCarry: [], sites: {}, workspaces: {} }));
        const folder = mkdtempSync(join(tmpdir(), 'trust-host-boot-ws-'));
        mkdirSync(join(folder, '.claude'), { recursive: true });
        writeFileSync(join(folder, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo boot-probe' }] }] } }));
        execFileSync('git', ['init', '-q'], { cwd: folder, windowsHide: true, stdio: 'ignore' });
        r = await hostingRig({ home, workspaces: () => [{ id: 'still-waiting', path: folder }] });
        const features = await r.features();
        // Well past the first pass, with nobody asking.
        for (let i = 0; i < 100 && r.stack.trust.view('still-waiting') === null; i += 1) await tick(5);
        expect(r.stack.trust.view('still-waiting')).toMatchObject({ trusted: false });
        const steps = (await features.snapshot()).trust ?? [];
        expect(steps.map((s) => s.workspaceId)).toEqual(['still-waiting']);
    });
});
