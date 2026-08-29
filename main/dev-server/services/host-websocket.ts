import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

export interface SockudoApp {
    id: string;
    key: string;
    secret: string;
}

export interface HostWebSocketProcess {
    id: string;
    stop: () => Promise<void>;
    logs: (tail?: number) => string | Promise<string>;
}

export interface HostWebSocketService {
    acquire: (app: SockudoApp) => Promise<{ processId: string; port: number; ready: boolean }>;
    release: (appId: string) => Promise<void>;
    logs: (tail?: number) => Promise<string>;
    stop: () => Promise<void>;
}

const tomlString = (value: string): string =>
    `"${value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')}"`;

/** Build the complete Sockudo configuration owned by the Genie Host. */
export function renderSockudoConfig(input: { port: number; apps: SockudoApp[] }): string {
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
        throw new Error(`Invalid Sockudo port: ${input.port}`);
    }
    const apps = [...input.apps].sort((a, b) => a.id.localeCompare(b.id));
    const ids = new Set<string>();
    for (const app of apps) {
        if (!app.id || !app.key || !app.secret) throw new Error('Sockudo app credentials cannot be empty.');
        if (ids.has(app.id)) throw new Error(`Duplicate Sockudo app id: ${app.id}`);
        ids.add(app.id);
    }

    const lines = [
        'debug = false',
        // The service is Host-native, while managed sites normally run inside a
        // container. Those sites dial the runtime's host-gateway address, which
        // cannot reach a loopback-only listener on Linux.
        'host = "0.0.0.0"',
        `port = ${input.port}`,
        'mode = "development"',
        'shutdown_grace_period = 2',
        '',
        '[adapter]',
        'driver = "local"',
        '',
        '[cache]',
        'driver = "memory"',
        '',
        '[queue]',
        'driver = "memory"',
        '',
        '[metrics]',
        'enabled = false',
        '',
        '[push]',
        'storage_driver = "memory"',
        'queue_driver = "memory"',
        'fcm_enabled = false',
        'apns_enabled = false',
        'webpush_enabled = false',
        'hms_enabled = false',
        'wns_enabled = false',
        '',
        '[app_manager]',
        'driver = "memory"',
        '',
        '[app_manager.array]',
    ];
    for (const app of apps) {
        lines.push(
            '[[app_manager.array.apps]]',
            `id = ${tomlString(app.id)}`,
            `key = ${tomlString(app.key)}`,
            `secret = ${tomlString(app.secret)}`,
            'enabled = true',
            '',
            '[app_manager.array.apps.policy.features]',
            'enable_client_messages = false',
            'enable_user_authentication = true',
            '',
            '[app_manager.array.apps.policy.channels]',
            'allowed_origins = ["*"]',
            '',
        );
    }
    return `${lines.join('\n')}\n`;
}

export function resolveBundledSockudo(
    resourcesPath: string,
    platform: NodeJS.Platform = process.platform,
): string {
    const api = platform === 'win32' ? path.win32 : path.posix;
    return api.join(resourcesPath, 'runtime', platform === 'win32' ? 'sockudo.exe' : 'sockudo');
}

/**
 * Owns one Sockudo process for the Host. The app registry is the desired state;
 * changing it atomically rewrites the complete config and replaces the process.
 */
export function createHostWebSocketService(deps: {
    port: number;
    writeConfig: (content: string) => Promise<void>;
    start: () => Promise<HostWebSocketProcess>;
    probe: (port: number) => Promise<boolean>;
}): HostWebSocketService {
    const apps = new Map<string, SockudoApp>();
    let process: HostWebSocketProcess | null = null;
    let queue = Promise.resolve();

    const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = queue.then(operation, operation);
        queue = result.then(() => undefined, () => undefined);
        return result;
    };

    const restart = async (): Promise<void> => {
        if (process) {
            await process.stop();
            process = null;
        }
        if (apps.size === 0) return;
        await deps.writeConfig(renderSockudoConfig({ port: deps.port, apps: [...apps.values()] }));
        const started = await deps.start();
        if (!(await deps.probe(deps.port))) {
            await started.stop().catch(() => {});
            throw new Error(`Sockudo started but did not become ready on 127.0.0.1:${deps.port}.`);
        }
        process = started;
    };

    return {
        acquire: (app) =>
            serialized(async () => {
                const previous = apps.get(app.id);
                const changed =
                    !previous || previous.key !== app.key || previous.secret !== app.secret;
                apps.set(app.id, { ...app });
                if (changed || !process) await restart();
                return { processId: process!.id, port: deps.port, ready: true };
            }),
        release: (appId) =>
            serialized(async () => {
                if (!apps.delete(appId)) return;
                await restart();
            }),
        logs: async (tail) => (process ? await process.logs(tail) : 'Sockudo is not running.'),
        stop: () =>
            serialized(async () => {
                if (!process) return;
                await process.stop();
                process = null;
            }),
    };
}

export function createBundledHostWebSocketService(input: {
    resourcesPath: string;
    userDataDir: string;
    port: number;
    platform?: NodeJS.Platform;
    probe: (port: number) => Promise<boolean>;
}): HostWebSocketService {
    const platform = input.platform ?? process.platform;
    const binary = resolveBundledSockudo(input.resourcesPath, platform);
    const dir = path.join(input.userDataDir, 'host-services', 'websocket');
    const configPath = path.join(dir, 'sockudo.toml');
    let logLines: string[] = [];

    return createHostWebSocketService({
        port: input.port,
        writeConfig: async (content) => {
            await fs.mkdir(dir, { recursive: true });
            const next = `${configPath}.next`;
            await fs.writeFile(next, content, { encoding: 'utf8', mode: 0o600 });
            await fs.rename(next, configPath);
        },
        start: async () => {
            if (!existsSync(binary)) {
                throw new Error(
                    `Genie's bundled Sockudo runtime is missing at ${binary}. Reinstall Genie to restore it.`,
                );
            }
            logLines = [];
            const child = spawn(binary, ['--config', configPath], {
                cwd: dir,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, RUST_LOG: 'info', LOG_OUTPUT_FORMAT: 'json' },
            });
            const append = (chunk: Buffer | string) => {
                logLines.push(...String(chunk).split(/\r?\n/).filter(Boolean));
                if (logLines.length > 2_000) logLines = logLines.slice(-2_000);
            };
            child.stdout?.on('data', append);
            child.stderr?.on('data', append);
            const stop = async () => {
                if (child.exitCode !== null || child.signalCode !== null) return;
                child.kill('SIGTERM');
                await Promise.race([
                    new Promise<void>((resolve) => child.once('exit', () => resolve())),
                    new Promise<void>((resolve) =>
                        setTimeout(() => {
                            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
                            resolve();
                        }, 3_000),
                    ),
                ]);
            };
            return {
                id: child.pid ? `sockudo-${child.pid}` : 'sockudo',
                stop,
                logs: (tail = 200) => logLines.slice(-Math.max(1, Math.min(tail, 2_000))).join('\n'),
            };
        },
        probe: input.probe,
    });
}
