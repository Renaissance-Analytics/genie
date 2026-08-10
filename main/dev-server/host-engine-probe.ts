import { execFile } from 'node:child_process';
import {
    detectDeclaredEngines,
    describeEngineMismatch,
    hostEngineProbe,
    stackToEngine,
    type DeclaredEngines,
} from './engine-version';

/**
 * The HOST side of engine-version validation (goal item 4, interim). The pure
 * detect/compare logic lives in `engine-version.ts`; this is the thin spawn: ask
 * the host for the installed version of an engine (`<engine> --version`), read it
 * with that engine's parser, and null out when the engine is not on PATH or the
 * probe fails/times out (which is itself a mismatch worth flagging).
 */
export function probeHostEngineVersion(engine: keyof DeclaredEngines): Promise<string | null> {
    const { command, parse } = hostEngineProbe(engine);
    const [bin, ...args] = command;
    return new Promise((resolve) => {
        try {
            execFile(bin, args, { timeout: 4_000, windowsHide: true }, (err, stdout, stderr) => {
                const out = `${stdout ?? ''}${stderr ?? ''}`;
                if (err && !out.trim()) return resolve(null);
                resolve(parse(out) ?? null);
            });
        } catch {
            resolve(null);
        }
    });
}

/**
 * Build the `engineMismatchNote` the site manager calls at a host-native start:
 * map the site's stack to its host engine, read what the repo declares, probe the
 * host, and return a one-line warning on a MAJOR-version mismatch (or when the
 * engine is absent) — else null. Nothing to check ⇒ null, so it is silent for a
 * static site or a repo that declares no version.
 */
export function createEngineMismatchNote(): (cwd: string, stack?: string) => Promise<string | null> {
    return async (cwd, stack) => {
        const engine = stackToEngine(stack);
        if (!engine) return null;
        const declared = detectDeclaredEngines(cwd)[engine];
        if (!declared) return null;
        const installed = await probeHostEngineVersion(engine).catch(() => null);
        return describeEngineMismatch(engine, declared, installed);
    };
}
