import {
    readOrCreatePublisherSecret,
    shuttleControlPath,
    startShuttle,
    type StartShuttleOptions,
    type StartShuttleResult,
} from './shuttle';

/**
 * THE SHUTTLE PROCESS'S FRONT DOOR.
 *
 * genie#346 Phase 1, `.ai/plans/genie-mcp-shuttle-spec.md` §3.2, §3.3. Genie spawns
 * the shuttle detached, on the shipped standalone Node, so there is no shared
 * memory and no IPC yet: everything the shuttle needs arrives in its environment,
 * and everything Genie needs back leaves as ONE JSON line on stdout plus an exit
 * code. Genie decides from those whether to attach or to serve in-process, so
 * each outcome is a distinct event and a distinct code — never prose to parse.
 *
 * Kept apart from `main.ts` (which only binds this to `process`) so every outcome
 * is testable without spawning anything.
 */

/** The process's exit codes, one per outcome. */
export const SHUTTLE_EXIT = {
    /** Ran, and was asked to stop. */
    ok: 0,
    /** The environment Genie gave it cannot describe a shuttle. */
    invalid: 2,
    /** It could not take the port or the pipe (`refused` names which). */
    refused: 3,
} as const;

export type ShuttleEnv = Record<string, string | undefined>;

export type ShuttleEvent =
    | { event: 'started'; pid: number; port: number; controlPath: string }
    | { event: 'refused'; reason: string; error: string }
    | { event: 'invalid'; error: string };

export interface ShuttleIo {
    /** One line to whoever spawned the process. */
    write(line: string): void;
    /** Register the handler for a request to stop (SIGTERM / SIGINT). */
    onSignal(handler: () => void): void;
    exit(code: number): void;
    /** Injectable for tests; the real start by default. */
    start?: (options: StartShuttleOptions) => Promise<StartShuttleResult>;
}

const integer = (raw: string | undefined, min: number, max: number): number | null => {
    if (raw === undefined || !/^\d+$/.test(raw.trim())) return null;
    const n = Number(raw);
    return n >= min && n <= max ? n : null;
};

/** The shuttle's options, from the environment Genie spawns it with. */
export function shuttleOptionsFromEnv(
    env: ShuttleEnv,
): { ok: true; options: StartShuttleOptions } | { ok: false; error: string } {
    const stateDir = env.GENIE_SHUTTLE_STATE_DIR?.trim();
    if (!stateDir) return { ok: false, error: 'GENIE_SHUTTLE_STATE_DIR is required.' };
    const port = integer(env.GENIE_SHUTTLE_PORT, 1, 65_535);
    if (port === null) {
        return { ok: false, error: `GENIE_SHUTTLE_PORT must be a port number, not ${JSON.stringify(env.GENIE_SHUTTLE_PORT)}.` };
    }
    const wireGeneration = integer(env.GENIE_SHUTTLE_WIRE_GENERATION, 0, Number.MAX_SAFE_INTEGER);
    if (wireGeneration === null) {
        return {
            ok: false,
            error: `GENIE_SHUTTLE_WIRE_GENERATION must be a whole number, not ${JSON.stringify(env.GENIE_SHUTTLE_WIRE_GENERATION)}.`,
        };
    }
    const shuttleVersion = env.GENIE_SHUTTLE_VERSION?.trim();
    if (!shuttleVersion) return { ok: false, error: 'GENIE_SHUTTLE_VERSION is required.' };

    let secret: string;
    try {
        secret = readOrCreatePublisherSecret(stateDir);
    } catch (e) {
        return { ok: false, error: `GENIE_SHUTTLE_STATE_DIR is not usable: ${(e as Error).message}` };
    }
    return {
        ok: true,
        options: { port, stateDir, controlPath: shuttleControlPath(stateDir), secret, wireGeneration, shuttleVersion },
    };
}

/** Start the shuttle, say how it went, and stop it cleanly when asked. */
export async function runShuttle(env: ShuttleEnv, io: ShuttleIo): Promise<void> {
    const say = (event: ShuttleEvent) => io.write(JSON.stringify(event));

    const parsed = shuttleOptionsFromEnv(env);
    if (!parsed.ok) {
        say({ event: 'invalid', error: parsed.error });
        io.exit(SHUTTLE_EXIT.invalid);
        return;
    }

    const result = await (io.start ?? startShuttle)(parsed.options);
    if (!result.ok) {
        say({ event: 'refused', reason: result.reason, error: result.error });
        io.exit(SHUTTLE_EXIT.refused);
        return;
    }

    const { shuttle } = result;
    let stopping = false;
    io.onSignal(() => {
        if (stopping) return;
        stopping = true;
        void shuttle.close().finally(() => io.exit(SHUTTLE_EXIT.ok));
    });
    say({ event: 'started', pid: process.pid, port: shuttle.port, controlPath: shuttle.controlPath });
}
