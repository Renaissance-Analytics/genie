/**
 * TYPING INTO A FRESH TERMINAL BEFORE ITS SHELL IS READY (#1640's question; measured on CI, never a desktop). One shared
 * measurement, two drivers: Genie's own terminal (typeahead-genie-cdp.mjs) and the same pty stack in-process with nothing
 * of Genie's around it (typeahead-conpty.mts). For each shell and each delay after the terminal opens, `echo <token>`
 * and Enter are typed; the run says whether the token came back as typed (the echo), whether the shell ran it (the token a
 * second time), and when the shell first drew anything. Five runs each, so one flake decides nothing.
 */
export const DELAYS_MS = [0, 500, 1000, 2000, 4000];
export const RUNS = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One run. `open()` answers `{ write(data), output(), close() }` — each may be async (a CDP call) — with `output` everything
 * the terminal has printed so far. The command is typed `delay` ms after open returned.
 */
export async function oneRun(open, delay, { waitMs = 20_000 } = {}) {
    const token = `ta${Math.random().toString(36).slice(2, 10)}`;
    const opened = Date.now();
    const t = await open();
    let firstOutputMs = null;
    let watching = true;
    // When the shell first drew anything (polled: `output` may be a CDP read).
    const watch = (async () => {
        while (watching && firstOutputMs === null) {
            if (String(await t.output()).length > 0) firstOutputMs = Date.now() - opened;
            else await sleep(20);
        }
    })();
    try {
        await sleep(delay);
        await t.write(`echo ${token}\r`);
        const count = async () => String(await t.output()).split(token).length - 1;
        const end = Date.now() + waitMs;
        while (Date.now() < end && (await count()) < 2) await sleep(50);
        const seen = await count();
        const tail = seen >= 2 ? '' : String(await t.output()).slice(-200).replace(/\s+/g, ' ');
        return { delay, echo: seen >= 1, ran: seen >= 2, firstOutputMs, tail };
    } finally {
        watching = false;
        await watch;
        try { await t.close(); } catch { /* gone */ }
    }
}

/** Every delay, RUNS times, for one shell; one line per delay: `TYPEAHEAD <driver> shell=… delay=… echo=n/5 ran=n/5 firstOutputMs=median`. */
export async function measureShell(driver, shell, open, say = console.log) {
    const rows = [];
    for (const delay of DELAYS_MS) {
        const runs = [];
        for (let i = 0; i < RUNS; i++) runs.push(await oneRun(open, delay));
        const firsts = runs.map((r) => r.firstOutputMs).filter((x) => x !== null).sort((a, b) => a - b);
        const row = { driver, shell, delay, echo: runs.filter((r) => r.echo).length, ran: runs.filter((r) => r.ran).length, runs: RUNS, firstOutputMs: firsts.length ? firsts[firsts.length >> 1] : null };
        rows.push(row);
        say(`TYPEAHEAD ${driver} shell=${shell} delay=${delay} echo=${row.echo}/${RUNS} ran=${row.ran}/${RUNS} firstOutputMs=${row.firstOutputMs ?? '-'}`);
        const missed = runs.find((r) => !r.ran);
        if (missed) say(`TYPEAHEAD-MISS ${driver} shell=${shell} delay=${delay} shown: ${missed.tail.slice(0, 160)}`);
    }
    return rows;
}

/** The shells measured: the default, then each of these where the machine has it. */
export const SHELLS = ['cmd.exe', 'powershell.exe', 'pwsh.exe'];
