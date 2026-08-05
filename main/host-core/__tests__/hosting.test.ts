import { describe, expect, it, vi } from 'vitest';
import { buildHostingDeps, type HostingPorts } from '../hosting';

/**
 * The host-owned HOSTING seam.
 *
 * Container hosting (dev sites + services + their lifecycle) is an agent ability,
 * so it belongs to the Host — not to the desktop shell that used to construct the
 * managers inline in `background.ts`, AFTER the `isHeadless()` bail (which made
 * hosting desktop-only and left the headless host unable to serve at all).
 *
 * `buildHostingDeps(ports)` is the pure heart of the seam: it maps ONE injected
 * port set into the three managers' dep objects. Proving that mapping here needs
 * no container runtime and no process-wide singletons — so it is the honest unit
 * to TDD. Both shells (desktop-backed, genie-cloud-backed) supply the ports; this
 * asserts the wiring is identical regardless of who backs them.
 */

function fakePorts(over: Partial<HostingPorts> = {}): HostingPorts {
    return {
        resolveRuntime: async () => ({ runtime: {} as never, detection: {} as never }),
        listWorkspaces: () => [],
        workspaceFor: () => null,
        devSitesFor: () => ({}),
        devServicesFor: () => ({}),
        engineAdmin: () => ({}) as never,
        devServiceEnvFor: () => ({}),
        onChanged: () => {},
        onSiteProgress: () => {},
        ...over,
    };
}

describe('buildHostingDeps — the host-core hosting seam', () => {
    it('maps ports into the three managers so the SHELL supplies the DB reads, not the boot', () => {
        const ports = fakePorts();
        const d = buildHostingDeps(ports);
        // The DB-backed reads come straight from the ports — desktop backs them
        // with genie.db, genie-cloud with its own store; the seam is identical.
        expect(d.sites.devSitesFor).toBe(ports.devSitesFor);
        expect(d.services.devServicesFor).toBe(ports.devServicesFor);
        expect(d.services.engineAdmin).toBe(ports.engineAdmin);
        expect(d.lifecycle.workspaceFor).toBe(ports.workspaceFor);
        // ONE runtime resolver, shared by all three.
        expect(d.sites.resolveRuntime).toBe(ports.resolveRuntime);
        expect(d.services.resolveRuntime).toBe(ports.resolveRuntime);
        expect(d.lifecycle.resolveRuntime).toBe(ports.resolveRuntime);
    });

    it('probes SERVICES (no in-container check) but not SITES (they probe through Caddy already)', () => {
        const d = buildHostingDeps(fakePorts());
        expect(typeof d.services.probeReady).toBe('function');
        expect(d.sites.probeReady).toBeUndefined();
    });

    it('routes both managers change events to the ONE onChanged port, and site progress to onSiteProgress', () => {
        const onChanged = vi.fn();
        const onSiteProgress = vi.fn();
        const d = buildHostingDeps(fakePorts({ onChanged, onSiteProgress }));
        d.services.onChanged?.();
        d.sites.onChanged?.();
        expect(onChanged).toHaveBeenCalledTimes(2);
        d.sites.onProgress?.({} as never);
        expect(onSiteProgress).toHaveBeenCalledTimes(1);
    });

    it('gives the lifecycle lazy handles to the live managers (the Host owns the orchestration)', () => {
        const d = buildHostingDeps(fakePorts());
        expect(typeof d.lifecycle.sites).toBe('function');
        expect(typeof d.lifecycle.services).toBe('function');
    });

    it('wires openInBrowser only when the shell provides it (desktop yes; headless leaves it a no-op)', () => {
        const opener = vi.fn(async () => ({ ok: true }));
        expect(buildHostingDeps(fakePorts()).siteTools.openInBrowser).toBeUndefined();
        expect(buildHostingDeps(fakePorts({ openInBrowser: opener })).siteTools.openInBrowser).toBe(opener);
    });
});
