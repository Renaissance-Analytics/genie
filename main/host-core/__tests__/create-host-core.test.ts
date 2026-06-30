import { describe, it, expect, vi } from 'vitest';
import { createHostCore, type HostCoreSteps } from '../index';
import type { HostBootOptions, HostCorePorts } from '../ports';

/** The orchestration contract of createHostCore — pure (no real DB/servers). */

const opts: HostBootOptions = { dataDir: '/data', serverVersion: '9.9.9', loopbackOnly: true };

function fakePorts(): HostCorePorts {
    return {
        encryptor: { isAvailable: () => true, encrypt: (b) => b, decrypt: (b) => b },
        questionTransport: { ask: async () => ({ cancelled: true, answers: [] }) },
        notifier: { imDone: () => {} },
        lifecycle: { keepAlive: vi.fn() },
    };
}

function fakeSteps(order: string[]): HostCoreSteps {
    return {
        initDatabase: vi.fn((dir: string) => {
            order.push(`db:${dir}`);
        }),
        wireTerminalAdapter: vi.fn(() => {
            order.push('adapter');
        }),
        runBackendSelection: vi.fn(async () => {
            order.push('backend');
            return { kind: 'in-process', host: false, reattachIds: [] } as never;
        }),
        registerTerminalEvents: vi.fn(() => {
            order.push('events');
        }),
        servers: {
            startMcp: vi.fn(async () => {
                order.push('mcp');
            }),
            mcpPort: () => 51000,
            startControl: vi.fn(async () => {
                order.push('control');
            }),
            startMobile: vi.fn(async () => {
                order.push('mobile');
            }),
            mobilePort: () => 52000,
            stop: vi.fn(async () => {
                order.push('stop');
            }),
        },
        teardownTerminals: vi.fn(async () => {
            order.push('teardown');
        }),
    };
}

describe('createHostCore.boot', () => {
    it('runs the GUI-free KEEP steps in order and returns the bound ports', async () => {
        const order: string[] = [];
        const steps = fakeSteps(order);
        const ports = fakePorts();
        const handle = await createHostCore(() => steps).boot(opts, ports);

        expect(order).toEqual([
            'db:/data',
            'adapter',
            'backend',
            'events',
            'mcp',
            'control',
            'mobile',
        ]);
        expect(ports.lifecycle.keepAlive).toHaveBeenCalledOnce();
        expect(handle.mcpPort).toBe(51000);
        expect(handle.mobilePort).toBe(52000);
    });

    it('passes the boot opts + ports to the steps factory', async () => {
        const make = vi.fn(() => fakeSteps([]));
        const ports = fakePorts();
        await createHostCore(make).boot(opts, ports);
        expect(make).toHaveBeenCalledWith(opts, ports);
    });

    it('shutdown stops the servers THEN tears down the terminals', async () => {
        const order: string[] = [];
        const steps = fakeSteps(order);
        const handle = await createHostCore(() => steps).boot(opts, fakePorts());
        order.length = 0;
        await handle.shutdown();
        expect(order).toEqual(['stop', 'teardown']);
    });
});
