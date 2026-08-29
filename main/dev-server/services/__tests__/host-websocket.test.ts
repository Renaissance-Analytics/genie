import { describe, expect, it } from 'vitest';
import {
    createHostWebSocketService,
    renderSockudoConfig,
    resolveBundledSockudo,
} from '../host-websocket';

describe('Host-native WebSocket runtime', () => {
    it('renders one isolated Pusher app per workspace without exposing the master secret', () => {
        const config = renderSockudoConfig({
            port: 49123,
            apps: [
                { id: 'alpha', key: 'alpha', secret: 'secret-a' },
                { id: 'beta', key: 'beta', secret: 'secret-b' },
            ],
        });

        // Sites inside Docker/Podman reach a Host-native service through the
        // runtime's host-gateway address. A loopback-only listener is unreachable
        // from that address on Linux.
        expect(config).toContain('host = "0.0.0.0"');
        expect(config).toContain('port = 49123');
        expect(config).toContain('[queue]\ndriver = "memory"');
        expect(config).toContain('[metrics]\nenabled = false');
        expect(config.match(/\[\[app_manager\.array\.apps\]\]/g)).toHaveLength(2);
        expect(config).toContain('id = "alpha"');
        expect(config).toContain('secret = "secret-a"');
        expect(config).not.toContain('REVERB_MASTER_SECRET');
    });

    it('escapes TOML strings instead of allowing workspace ids to alter configuration', () => {
        const config = renderSockudoConfig({
            port: 49123,
            apps: [{ id: 'bad"\nport = 1', key: 'key', secret: 'secret' }],
        });
        expect(config).toContain('id = "bad\\"\\nport = 1"');
        expect(config).not.toContain('\nport = 1\n');
    });

    it('resolves only the bundled binary for the current packaged platform', () => {
        expect(resolveBundledSockudo('C:/Genie/resources', 'win32')).toBe(
            'C:\\Genie\\resources\\runtime\\sockudo.exe',
        );
        expect(resolveBundledSockudo('/opt/Genie/resources', 'linux')).toBe(
            '/opt/Genie/resources/runtime/sockudo',
        );
    });

    it('restarts the one Host process when its workspace app registry changes', async () => {
        const configs: string[] = [];
        const stopped: string[] = [];
        let starts = 0;
        const service = createHostWebSocketService({
            port: 49_123,
            writeConfig: async (value) => {
                configs.push(value);
            },
            start: async () => {
                const id = `sockudo-${++starts}`;
                return {
                    id,
                    stop: async () => {
                        stopped.push(id);
                    },
                    logs: () => `${id} ready`,
                };
            },
            probe: async () => true,
        });

        expect(await service.acquire({ id: 'alpha', key: 'alpha', secret: 'one' })).toMatchObject({
            processId: 'sockudo-1',
            port: 49_123,
            ready: true,
        });
        await service.acquire({ id: 'beta', key: 'beta', secret: 'two' });

        expect(stopped).toEqual(['sockudo-1']);
        expect(configs.at(-1)).toContain('id = "alpha"');
        expect(configs.at(-1)).toContain('id = "beta"');
        expect(await service.logs()).toBe('sockudo-2 ready');

        await service.release('alpha');
        expect(stopped).toEqual(['sockudo-1', 'sockudo-2']);
        expect(configs.at(-1)).not.toContain('id = "alpha"');
    });
});
