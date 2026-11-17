// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { applyMachineFeatureAction } from '../src/main/feature-machine.js';
import { tailscaleCommand, type TailscaleStatus } from '../src/main/tailscale-cli.js';
import { RemoteAccess } from '../src/renderer/components/FeatureSurfaces.js';
import type { FeatureAction, RemoteSection } from '../src/renderer/features.js';
import { control } from './helpers/control-markup.js';

/**
 * TAILSCALE NOTICED WITHOUT A RELAUNCH (Tynn #749) and ONE INSTALLER (Tynn #748): the wiring around tailscale-live.
 *  - The tailnet listener ran `tailscale` through a PATH lookup. Windows' Tailscale installer puts its folder on the
 *    machine's PATH, which a process already running never sees, so the host looked for C:\Windows\System32\tailscale.exe
 *    until it was relaunched: "Shut down everything" was the only cure. The CLI is now found at each call.
 *  - Restart re-reads Tailscale; opening Remote access (or focusing its window) reads it again.
 *  - Install, while under way, stays the same button, disabled and busy: nothing moves, and a second click does nothing.
 */
const strip = (file: string): string => readFileSync(file, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('the tailnet listener finds the Tailscale CLI at each call (Tynn #749)', () => {
    it('absent at the first call, installed later, run at the next: no relaunch', async () => {
        let installed = false;
        const ran: string[] = [];
        const deps = {
            cliPath: () => (installed ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : null),
            run: async (cli: string, args: string[]) => { ran.push(`${cli} ${args.join(' ')}`); return { stdout: '{"BackendState":"Running"}', stderr: '' }; },
        };
        await expect(tailscaleCommand(['status', '--json'], 8_000, deps)).rejects.toThrow(/not installed/i);
        installed = true;
        expect(await tailscaleCommand(['status', '--json'], 8_000, deps)).toBe('{"BackendState":"Running"}');
        expect(ran).toEqual(['C:\\Program Files\\Tailscale\\tailscale.exe status --json']);
    });

    it('CONTROL: no Tailscale at all: refused in words, nothing run', async () => {
        let runs = 0;
        await expect(tailscaleCommand(['status', '--json'], 8_000, { cliPath: () => null, run: async () => { runs++; return { stdout: '', stderr: '' }; } })).rejects.toThrow(/Tailscale is not installed/);
        expect(runs).toBe(0);
    });

    it('genie-host runs the listener and its certificate through tailscaleCommand, never a PATH lookup of tailscale', () => {
        const host = strip('src/main/genie-host.ts');
        expect(host).not.toMatch(/resolveProgram\(\s*['"]tailscale['"]\s*\)/);
        expect(host).toMatch(/tailscale:\s*\(\)\s*=>\s*tailscaleCommand\(\['status', '--json'\]/);
        expect(host).toMatch(/tailscaleCommand\(\['cert',/);
    });

    it('genie-host keeps Tailscale in one live view: status, install, Connect and the re-read all go through tailscaleLive', () => {
        const host = strip('src/main/genie-host.ts');
        expect(host).toMatch(/tailscaleLive\(\{/);
        expect(host).not.toMatch(/installTailscale\(\{[^}]*\}\)\s*;\s*await refreshFeatureTailscale/);
        expect(host).toMatch(/online:\s*\(\)\s*=>\s*remoteSwitch\.apply\(\)/);
    });
});

describe('Remote access re-reads Tailscale (Tynn #749)', () => {
    const tailscalePort = (calls: string[]) => ({
        status: () => null, up: async () => ({ ok: true }), install: async () => ({ started: false }),
        refresh: async () => { calls.push('refresh'); },
    });

    it('Restart reads Tailscale again BEFORE restarting the listener', async () => {
        const calls: string[] = [];
        const ports = { tailscale: tailscalePort(calls), remoteAccess: { apply: async () => {}, restart: async () => { calls.push('restart'); } } };
        await applyMachineFeatureAction({} as never, { kind: 'remote.restart' }, {} as never, {} as never, ports as never);
        expect(calls).toEqual(['refresh', 'restart']);
    });

    it('Remote access opened: tailscale.refresh reads Tailscale again', async () => {
        const calls: string[] = [];
        const handled = await applyMachineFeatureAction({} as never, { kind: 'tailscale.refresh' } as FeatureAction, {} as never, {} as never, { tailscale: tailscalePort(calls) } as never);
        expect(handled).toBe(true);
        expect(calls).toEqual(['refresh']);
    });
});

const base: RemoteSection = { host: 'laptop', url: null, unavailable: 'Tailscale is not installed', locked: false, pin: null, devices: [], connections: [], enabled: true, firewall: false };
const absent = (over: Partial<TailscaleStatus> = {}): TailscaleStatus => ({ installed: false, running: false, state: 'absent', self: null, peers: [], remedy: { message: 'Tailscale is not installed on this machine.' }, ...over });
const html = (tailscale: TailscaleStatus) => renderToStaticMarkup(<RemoteAccess remote={{ ...base, tailscale }} workspaces={[]} onAction={() => {}} />);

describe('Install Tailscale while under way (Tynn #748)', () => {
    it('the same button, the same words, disabled and busy: nothing moves and a second click does nothing', () => {
        const button = control(html(absent({ installing: true })), 'data-action="tailscale-install"');
        expect(button?.fancy).toBe(true);
        expect(button?.text).toBe('Install Tailscale');
        expect(button?.open).toMatch(/\sdisabled=""/);
        expect(button?.open).toMatch(/data-busy="true"/);
    });

    it('CONTROL: not under way, Install is there and enabled', () => {
        const button = control(html(absent()), 'data-action="tailscale-install"');
        expect(button?.text).toBe('Install Tailscale');
        expect(button?.open).not.toMatch(/\sdisabled=""/);
    });

    it('the Tailscale row asks main to read Tailscale when it opens and again when its window regains focus', async () => {
        const kinds: string[] = [];
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        await act(async () => { root.render(<RemoteAccess remote={{ ...base, tailscale: absent() }} workspaces={[]} onAction={(a) => { kinds.push(a.kind); }} />); });
        expect(kinds.filter((k) => k === 'tailscale.refresh')).toHaveLength(1);
        await act(async () => { window.dispatchEvent(new Event('focus')); });
        expect(kinds.filter((k) => k === 'tailscale.refresh')).toHaveLength(2);
        await act(async () => { root.unmount(); });
        host.remove();
    });
});
