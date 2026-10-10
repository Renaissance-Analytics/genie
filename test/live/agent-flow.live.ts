/**
 * THE LIVE FLOW — a real agent, through the real host, into the rows the UI renders.
 *
 * `claude-session.live.ts` proves the session layer against the real CLI. This proves the
 * layer above it: **`SessionHost` → `TimedEvent[]` → `ledgerRow()` → what a person reads.**
 *
 * That join is where the previous build's defects lived. Every one of its four broken releases
 * had a green unit suite, because a fake driver proves the plumbing and can never prove that
 * the protocol arrives in the shape the mapper expects — nor that the mapper's output makes
 * sensible rows.
 *
 * Run it with `npm run verify:flow` before anything is tagged. It is deliberately NOT part of
 * `npm test`: it needs the provider binary installed and authenticated, and it spends real
 * subscription tokens, so it asks for the smallest useful turn.
 *
 * What it proves, in order:
 *
 *   1. the host starts a real session and counts it;
 *   2. real `session/update` frames become ledger rows WITH arrival timestamps;
 *   3. an agent message survives the whole chain into a readable row;
 *   4. the turn ENDS and the agent returns to idle — the signal without which every agent
 *      reads "Working" forever, because the CLI stays alive across turns;
 *   5. the probe the Dashboard reads reports that agent correctly;
 *   6. stop frees the slot and leaves nothing behind.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeDriver } from '@particle-academy/prism-acp';
import { agentRecord, mintAgentId } from '../../src/core/identity.js';
import { agentRowFor } from '../../src/core/roster.js';
import { ledgerRow } from '../../src/core/stream-view.js';
import { SessionHost, type DriverFor } from '../../src/main/session-host.js';

const CLAUDE_BINARY = process.env['GENIE2_CLAUDE_BINARY'] ?? 'claude';

const failures: string[] = [];
function check(ok: boolean, label: string, detail = ''): void {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures.push(label);
}

async function until(predicate: () => boolean, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 400));
    }
    return false;
}

async function main(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'genie2-flow-'));
    console.log(`\ngenie2 live FLOW check — cwd ${dir}\n`);

    /**
     * The real driver, with one safety change: `permissionMode: 'plan'`.
     *
     * The live check must never be able to edit anything on the owner's machine. It is passed
     * HERE, in the harness's own factory, rather than being a mode the product can be put into
     * by an environment variable — the previous build's `GENIE_E2E` changed how the app
     * behaved and so tested a different product.
     */
    const driverFor: DriverFor = (_record, cwd, resumeSessionId) => (options) =>
        new ClaudeDriver(
            {
                cwd,
                binary: CLAUDE_BINARY,
                permissionMode: 'plan',
                ...(resumeSessionId ? { resumeSessionId } : {}),
            },
            {
                onUpdate: (u) => options.events.onUpdate?.(u as Record<string, unknown>),
                onTurnEnd: (o) => options.events.onTurnEnd?.(o),
                onExit: (code, signal) => options.events.onExit?.(code, signal),
            },
        );

    const host = new SessionHost({ userData: dir, driverFor });
    const record = agentRecord({
        id: mintAgentId(),
        workspaceId: 'live',
        provider: 'claude',
        name: 'flowcheck',
    });

    try {
        const started = host.start(record, dir);
        check(started.ok, '1. the host starts a real session', JSON.stringify(started));
        check(host.count === 1, '1b. and counts it — sessions, never processes', `count=${host.count}`);

        host.prompt(record.id, 'Reply with exactly the word: ok');

        const gotRows = await until(() => host.rowsFor(record.id).length > 0, 120_000);
        const rows = host.rowsFor(record.id);
        check(gotRows, '2. real protocol frames became ledger rows', `${rows.length} rows`);

        // Timestamps are recorded on ARRIVAL, because the wire carries none. A row with no time
        // is why Lanes renders a sentence rather than four empty tracks.
        check(
            rows.length > 0 && rows.every((r) => typeof r.at === 'number'),
            '2b. every row carries an arrival timestamp',
        );

        const message = rows.find((r) => r.event.kind === 'message' && r.event.speaker === 'agent');
        check(Boolean(message), '3. an agent message reached the ledger');

        if (message) {
            // The whole chain, ending at what a person actually reads.
            const rendered = ledgerRow(message);
            check(
                rendered.main.length > 0 && rendered.icon.length > 0,
                '3b. and renders as a readable row',
                `${rendered.icon} · ${rendered.main.slice(0, 60)}`,
            );
        }

        /**
         * 4. THE TURN ENDS.
         *
         * With `--input-format stream-json` the CLI stays alive across turns, so the process
         * never exits between them. Without `onTurnEnd` every agent anyone had prompted would
         * read `Working` on the Dashboard forever, with a duration counting up beside it.
         *
         * This is the one assertion in the suite that could not be made with a fake driver,
         * because the question is whether the REAL CLI sends the frame prism-acp maps to it.
         */
        const idled = await until(() => host.probe(record.id)?.turnState === 'idle', 60_000);
        check(idled, '4. the turn ENDED and the agent returned to idle', `turnState=${host.probe(record.id)?.turnState}`);
        check((host.turnsFor(record.id)) >= 1, '4b. the turn was counted', `${host.turnsFor(record.id)} turns`);

        // 5. What the Dashboard reads.
        const live = host.probe(record.id);
        const row = agentRowFor(record, live, () => Date.now());
        check(row.state === 'idle', '5. the Dashboard row reads idle, not working', row.state);
        check(row.fidelity === 'declared', '5b. and DECLARED — the §0.4 field', row.fidelity);
        check(
            row.collaborators === null && row.delivery === null,
            '5c. and claims nothing it was not told',
            `collaborators=${row.collaborators} delivery=${row.delivery}`,
        );

        // 6. Stop frees the slot. The previous build returned ok while leaving the provider
        //    alive, so the owner had agents they could not stop AND a capacity figure that
        //    never came back down.
        const stopped = host.stop(record.id);
        check(stopped && host.count === 0, '6. stop frees the slot', `count=${host.count}`);
        check(host.probe(record.id) === null, '6b. and the probe reports no session');
    } finally {
        host.stopAll();
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
        } catch {
            // The session persists rows with a fire-and-forget append, so a write can still be
            // in flight. A temp directory left behind is not a failure of what is being tested.
        }
    }

    console.log('');
    if (failures.length > 0) {
        console.log(`FLOW CHECK FAILED — ${failures.length}:\n  ${failures.join('\n  ')}`);
        process.exit(1);
    }
    console.log('FLOW CHECK PASSED — real frames, real rows, a real turn ending, nothing left running.');
}

await main();
