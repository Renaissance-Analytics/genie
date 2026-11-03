import { EventEmitter } from 'node:events';
import { join } from 'node:path';

/**
 * ONE LONG-LIVED POWERSHELL, BECAUSE THE LAUNCH WAS THE COST (genie-test-windows: a launch 1.6 to 2.2 s, the same ACL work through a running helper 2 to 16 ms, the same ACL left behind). A write on
 * Windows launched PowerShell every time, and so did every reading of the process table.
 *
 * It holds nothing: scripts arrive as `<id> <base64 UTF-16>` a line, each script's own output comes back, and `DONE <id> 0|1` ends it. Paths and a SID are all a script ever holds, no secret goes
 * through it. stdin is a pipe of its owner's alone, and its end is the helper's end: when the owner dies, however it dies, the pipe closes. Measured with the owner killed outright, idle 63 ms and
 * busy 70 ms (the pipe going takes a running script with it).
 *
 * A HELPER THAT DOES NOT ANSWER IS TRIED ONCE MORE, THEN LEFT ALONE. Each loss costs a write its deadline, and a launch after it, which is right once and wrong for a burst. Two losses in a row and it rests (5 minutes): a request is told at once and the
 * caller launches. An answer ends the count. Starting one runs CreateProcess on this thread, which has held a thread for minutes on a real machine (genie#1397), so a slow start is said.
 *
 * ONE REQUEST AT A TIME, so a script's handshake has stdin to itself. A dead helper or one past the deadline loses the request (`HelperLost`), and it is the caller's to do the work another way:
 * nothing here ever reports a request done that the script did not say was done.
 */
export class HelperLost extends Error {
    constructor(message: string) { super(message); this.name = 'HelperLost'; }
}

export interface HelperChild extends EventEmitter {
    readonly pid?: number | undefined;
    readonly stdin: { write(text: string): unknown; end(): unknown } | null;
    readonly stdout: EventEmitter | null;
    kill(): boolean;
}

export interface HelperRequest {
    /** The script's handshake. An end says its words and leaves the pipe open: the pipe is the helper's. */
    readonly stdin: EventEmitter & { write(text: string): boolean; end(text?: string): void; destroy(): void };
    readonly stdout: EventEmitter;
    readonly completed: Promise<{ stdout: string; stderr: string }>;
    kill(): void;
}

export interface WindowsHelperOptions {
    /** Who starts it: private-credentials.ts, which already may. This module spawns nothing itself (test/no-spawn-on-main-guard.test.ts). */
    readonly spawn: (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => HelperChild;
    readonly deadlineMs?: number;
    readonly log?: (line: string) => void;
    readonly restMs?: number;
    readonly now?: () => number;
}

// Real timers, taken at load: a test faking the clock (or advancing it 30 s) is not a helper past its deadline.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** A script past this is hung: a write takes milliseconds here, and a cold start under two seconds. Long enough for a stalled machine, and the caller still has a launch to try. */
const DEFAULT_DEADLINE_MS = 20_000;
const DEFAULT_REST_MS = 5 * 60_000;
/** Two in a row, so a single stall costs one restart and no more. */
const LOSSES_BEFORE_REST = 2;
const SLOW_START_MS = 1_000;

const LOOP = `
$utf=[Text.UTF8Encoding]::new($false)
$in=[IO.StreamReader]::new([Console]::OpenStandardInput(),$utf)
$out=[Console]::OpenStandardOutput()
function Send-Line([string]$m){ $b=$utf.GetBytes($m+[Environment]::NewLine); $out.Write($b,0,$b.Length); $out.Flush() }
Send-Line 'READY'
while($null -ne ($line=$in.ReadLine())){
    $id,$body=$line -split ' ',2
    try {
        $s=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($body))
        $ErrorActionPreference='Stop'
        & ([scriptblock]::Create($s)) | ForEach-Object { Send-Line "$_" }
        Send-Line "DONE $id 0"
    } catch { Send-Line "DONE $id 1" }
}
exit 0
`;

/** The same PowerShell, the same flags and the same environment as a launch for one write. */
export function helperSpawnArgs(): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PSMODULEPATH') delete env[key];
    return {
        file: join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(LOOP, 'utf16le').toString('base64')],
        env,
    };
}

interface Pending {
    readonly id: number;
    readonly body: string;
    readonly stdout: EventEmitter;
    text: string;
    resolve(value: { stdout: string; stderr: string }): void;
    reject(error: unknown): void;
    timer: ReturnType<typeof setTimeout> | null;
}

export class WindowsHelper {
    readonly #spawn: WindowsHelperOptions['spawn'];
    readonly #deadlineMs: number;
    readonly #log: (line: string) => void;
    #child: HelperChild | null = null;
    #buffer = '';
    #active: Pending | null = null;
    readonly #queue: Pending[] = [];
    #next = 0;
    #lastPid: number | null = null;
    readonly #restMs: number;
    readonly #now: () => number;
    #losses = 0;
    #restingUntil = 0;

    constructor(options: WindowsHelperOptions) {
        this.#spawn = options.spawn;
        this.#deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
        this.#log = options.log ?? (() => {});
        this.#restMs = options.restMs ?? DEFAULT_REST_MS;
        this.#now = options.now ?? Date.now;
    }

    /** One more lost. At the limit it rests, and whoever is waiting is told now: the caller has a launch, and none of them should wait out a deadline first. */
    #lost(why: string): void {
        this.#losses += 1;
        if (this.#losses < LOSSES_BEFORE_REST) return;
        this.#restingUntil = this.#now() + this.#restMs;
        // After the rest, one try: its failure rests again at once.
        this.#losses = LOSSES_BEFORE_REST - 1;
        this.#log(`windows helper: resting for ${Math.round(this.#restMs / 1000)} s, writes launch meanwhile: ${why}`);
        for (const waiting of this.#queue.splice(0)) waiting.reject(new HelperLost(`the helper is resting: ${why}`));
    }

    /** The running helper's pid, or the last one's. */
    get pid(): number | null { return this.#lastPid; }

    run(body: string): HelperRequest {
        const stdout = new EventEmitter();
        let resolve!: Pending['resolve'];
        let reject!: Pending['reject'];
        const completed = new Promise<{ stdout: string; stderr: string }>((yes, no) => { resolve = yes; reject = no; });
        const pending: Pending = { id: ++this.#next, body, stdout, text: '', resolve, reject, timer: null };
        const stdin = Object.assign(new EventEmitter(), {
            write: (text: string): boolean => { if (this.#active === pending) this.#child?.stdin?.write(text); return true; },
            end: (text?: string): void => { if (text !== undefined && this.#active === pending) this.#child?.stdin?.write(text); },
            destroy: (): void => {},
        });
        if (this.#now() < this.#restingUntil) {
            reject(new HelperLost('the helper is resting'));
            return { stdin, stdout, completed, kill: () => {} };
        }
        this.#queue.push(pending);
        // After this turn, so a caller can attach to stdout before anything can arrive.
        queueMicrotask(() => this.#pump());
        return { stdin, stdout, completed, kill: () => { if (this.#active === pending) this.#lose('the request was ended'); } };
    }

    /** Close its stdin, which ends it. Anything still waiting is lost. */
    stop(): void {
        const child = this.#child;
        this.#child = null;
        try { child?.stdin?.end(); } catch { /* already gone */ }
        this.#failAll('the helper was stopped');
    }

    #start(): HelperChild | null {
        if (this.#child) return this.#child;
        const { file, args, env } = helperSpawnArgs();
        let child: HelperChild;
        const began = this.#now();
        try {
            child = this.#spawn(file, args, env);
        } catch (error) {
            const why = `could not start: ${error instanceof Error ? error.message : String(error)}`;
            this.#log(`windows helper: ${why}`);
            this.#lost(why);
            return null;
        }
        const held = this.#now() - began;
        if (held >= SLOW_START_MS) this.#log(`windows helper: starting it held this thread ${held} ms`);
        this.#child = child;
        this.#lastPid = child.pid ?? null;
        this.#buffer = '';
        // Writing to a helper that has just died is its exit's to report, not an uncaught EPIPE's.
        (child.stdin as unknown as Partial<EventEmitter> | null)?.on?.('error', () => {});
        child.stdout?.on('data', (data: Buffer | string) => { if (this.#child === child) this.#heard(data.toString()); });
        const gone = (why: string): void => {
            if (this.#child !== child) return;
            this.#child = null;
            // Idle, it is no loss: nothing was waiting on it.
            if (this.#active) { this.#log(`windows helper: ${why}`); this.#lost(why); }
            this.#failActive(why);
            this.#pump();
        };
        child.once('exit', () => gone('the helper exited'));
        child.once('error', (error: unknown) => gone(`the helper failed: ${error instanceof Error ? error.message : String(error)}`));
        return child;
    }

    #pump(): void {
        if (this.#active || this.#queue.length === 0) return;
        const pending = this.#queue.shift()!;
        const child = this.#start();
        if (!child) {
            pending.reject(new HelperLost('the helper could not be started'));
            this.#pump();
            return;
        }
        this.#active = pending;
        this.#refChild(child, true);
        pending.timer = realSetTimeout(() => this.#lose(`no answer within ${this.#deadlineMs} ms`), this.#deadlineMs);
        try {
            child.stdin?.write(`${pending.id} ${Buffer.from(pending.body, 'utf16le').toString('base64')}\n`);
        } catch (error) {
            this.#lose(`the helper could not be written to: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /** While a request runs, the owner must stay up for its answer; idle, the helper must not hold the owner open. */
    #refChild(child: HelperChild, on: boolean): void {
        const c = child as unknown as { ref?: () => void; unref?: () => void };
        const out = child.stdout as unknown as { ref?: () => void; unref?: () => void } | null;
        if (on) { c.ref?.(); out?.ref?.(); } else { c.unref?.(); out?.unref?.(); }
    }

    #heard(text: string): void {
        this.#buffer += text;
        for (;;) {
            const end = this.#buffer.indexOf('\n');
            if (end < 0) return;
            const line = this.#buffer.slice(0, end).replace(/\r$/, '');
            this.#buffer = this.#buffer.slice(end + 1);
            this.#line(line);
        }
    }

    #line(line: string): void {
        if (line === 'READY') return;
        const active = this.#active;
        if (!active) return;
        const done = /^DONE (\d+) ([01])$/.exec(line);
        if (done && Number(done[1]) === active.id) {
            this.#settle(active);
            this.#losses = 0;
            if (done[2] === '0') active.resolve({ stdout: active.text, stderr: '' });
            else active.reject(Object.assign(new Error('the script refused'), { code: 1 }));
            if (this.#child) this.#refChild(this.#child, false);
            queueMicrotask(() => this.#pump());
            return;
        }
        active.text += `${line}\n`;
        active.stdout.emit('data', `${line}\n`);
    }

    #settle(pending: Pending): void {
        if (pending.timer) realClearTimeout(pending.timer);
        pending.timer = null;
        if (this.#active === pending) this.#active = null;
    }

    #failActive(why: string): void {
        const active = this.#active;
        if (!active) return;
        this.#settle(active);
        active.reject(new HelperLost(why));
    }

    #lose(why: string): void {
        this.#log(`windows helper: ${why}`);
        const child = this.#child;
        this.#child = null;
        this.#lost(why);
        this.#failActive(why);
        try { child?.kill(); } catch { /* already gone */ }
        queueMicrotask(() => this.#pump());
    }

    #failAll(why: string): void {
        this.#failActive(why);
        for (const waiting of this.#queue.splice(0)) waiting.reject(new HelperLost(why));
    }
}
