import { createServer } from 'node:net';

/**
 * WHO HOLDS :443 — the front door's ports, asked before Genie's Caddy starts and read from Caddy's own words while it
 * runs. Caddy serves https://<name>.gen on 127.0.0.1:443 (and :80 for the redirect). When another process already
 * holds one, Caddy exits, the supervisor's `always` restarts it, it exits again — and Hosting said `running` the whole
 * time. Genie 1 said "another process holds :443" (its host-caddy.ts); so does this: the front door is held, not
 * started and not restarted, with the holder's name when the OS will say it, until the person tries again.
 */

export const FRONT_DOOR_PORTS = [443, 80] as const;
export type FrontDoorPort = (typeof FRONT_DOOR_PORTS)[number];

/** `free`; `held` — someone else has it; `denied` — the OS will not let this process bind it (a Linux privileged port). */
export type PortProbe = 'free' | 'held' | 'denied';

export interface FrontDoorPorts {
    probe(port: FrontDoorPort): Promise<PortProbe>;
    /** The holding process's name, or `null` when the OS will not say. */
    holder(port: FrontDoorPort): Promise<string | null>;
}

export interface FrontDoorBlocked {
    readonly port: FrontDoorPort;
    readonly holder: string | null;
    readonly reason: string;
}

export function heldReason(port: FrontDoorPort, holder: string | null): string {
    return `another process holds :${port}${holder ? ` (${holder})` : ''}; https://<name>.gen in external browsers is off until it lets go — the in-app browser still works`;
}

/**
 * Caddy's own words for a front-door port it could not bind — at start, or on a --watch reload that added the first
 * route. `held` for an address in use (Linux "address already in use", Windows "Only one usage of each socket
 * address"); `refused` for anything else the bind said (a privileged port, a reserved range), with Caddy's words.
 */
export function bindFailure(output: string): { port: FrontDoorPort; kind: 'held' | 'refused'; words: string } | null {
    const m = /listen tcp [^\s]*?:(443|80): bind: ([^\r\n"]+)/i.exec(output);
    if (!m) return null;
    const port = Number(m[1]) as FrontDoorPort;
    const words = m[2]!.trim();
    const held = /address already in use|only one usage of each socket address/i.test(words);
    return { port, kind: held ? 'held' : 'refused', words };
}

/** Bind 127.0.0.1:<port> exclusively and let go at once — the same address Caddy's `default_bind` asks for. */
export function probeLoopbackPort(port: number): Promise<PortProbe> {
    return new Promise((resolve) => {
        const server = createServer();
        server.unref();
        server.once('error', (error: NodeJS.ErrnoException) => {
            // Windows answers EACCES for a port http.sys (or a reserved range) holds; Linux answers it for a privileged
            // port, which Caddy may still bind (a capability) — so only Windows reads it as held.
            if (error.code === 'EADDRINUSE' || (error.code === 'EACCES' && process.platform === 'win32')) resolve('held');
            else if (error.code === 'EACCES') resolve('denied');
            else resolve('free');
        });
        server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve('free')));
    });
}

type Run = (command: string, args: readonly string[]) => Promise<{ exitCode: number; stdout: string }>;

/** The name of the process listening on `port`, read-only, per OS; `null` whenever the OS does not say plainly. */
export async function listeningProcess(platform: NodeJS.Platform, port: number, run: Run): Promise<string | null> {
    try {
        if (platform === 'win32') {
            // PID 4 is the kernel's http.sys (IIS, WinRM, a reserved URL): no process name to show but "System".
            const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$c = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { if ($c.OwningProcess -eq 4) { 'System (http.sys)' } else { (Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue).ProcessName } }`]);
            const name = r.stdout.trim().split(/\r?\n/)[0]?.trim();
            return r.exitCode === 0 && name ? name : null;
        }
        if (platform === 'darwin') {
            const r = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fc']);
            const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith('c'));
            return line ? line.slice(1).trim() || null : null;
        }
        const r = await run('ss', ['-H', '-ltnp', `sport = :${port}`]);
        return /users:\(\("([^"]+)"/.exec(r.stdout)?.[1] ?? null;
    } catch {
        return null;
    }
}

export function realFrontDoorPorts(platform: NodeJS.Platform, run: Run): FrontDoorPorts {
    return { probe: (port) => probeLoopbackPort(port), holder: (port) => listeningProcess(platform, port, run) };
}
