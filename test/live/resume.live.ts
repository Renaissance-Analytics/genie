/**
 * DOES A CONVERSATION ACTUALLY SURVIVE A RESTART?
 *
 * P1's done-when says it does. That was true of the session layer, which resumes whatever
 * `resumeSessionId` it is handed — and **no code path in the app ever stored one**, so Genie
 * was asking the session to resume an id it had never kept. Every unit test about resume
 * passed, because every one of them handed the id in.
 *
 * This proves the whole chain against the real Claude CLI, through genie2's own capture path:
 *
 *   the provider reports its session id
 *     -> the session notices it, once
 *       -> the host guards it
 *         -> the registry writes it to agents.json
 *           -> a SECOND registry and host read it back, which is what a restart is
 *             -> the driver resumes, and the model still remembers
 *
 * ## Why a nonce, and why a negative control
 *
 * "Do you remember what I said" can be answered plausibly by a model that remembers nothing.
 * So the thing to remember is a random token no model can guess, and the assertion is that the
 * exact token comes back.
 *
 * That is still not enough on its own: the token also comes back from a build where resume
 * does nothing and the two turns happen to share one process. So a THIRD agent — same
 * question, no stored thread — must NOT know the token. Without that control this check passes
 * on a build with no resume at all, which is precisely the build it was written to catch.
 *
 * Four small turns of real tokens. Run it with `npm run verify:resume` before anything is
 * tagged, not on every save.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeDriver } from '@particle-academy/prism-acp';
import type { AgentId } from '../../src/core/identity.js';
import { Registry } from '../../src/main/registry.js';
import { SessionHost, type DriverFor } from '../../src/main/session-host.js';
import { Store } from '../../src/main/store.js';

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

/**
 * The real driver, in `plan` mode so this can never edit anything on the owner's machine.
 *
 * Passed by the HARNESS rather than selected by an environment variable the product reads: the
 * previous build's `GENIE_E2E` changed how the app behaved, and so tested a different product
 * from the one it shipped.
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
            onProtocolError: (p) => options.events.onProtocolError?.(p),
            onExit: (code, signal) => options.events.onExit?.(code, signal),
        },
    );

/**
 * A registry and host wired exactly as `main.ts` wires them.
 *
 * Including `onThreadId`, which is the connection whose absence is the whole subject of this
 * file. A harness that wired it differently would be proving its own plumbing.
 */
function openApp(dir: string): { registry: Registry; host: SessionHost } {
    const registry = new Registry(new Store(dir));
    const host = new SessionHost({
        userData: dir,
        driverFor,
        onThreadId: (agentId, threadId) => {
            void registry.recordThread(agentId, threadId);
        },
    });
    registry.setProbe((id) => host.probe(id) ?? null);
    return { registry, host };
}

/**
 * Ask, wait for the TURN TO END, and return everything the agent said.
 *
 * ## Waiting for a message is a race, and it lost on the first run
 *
 * The first version waited for a new agent message row to appear. It passed checks 1 to 5 and
 * then reported the recalled token as `zephyr-21d688` where the token was `zephyr-21d688cc`,
 * and the first turn's "OK" as `O`. Nothing was broken: a reply arrives as a stream of
 * `agent_message_chunk` frames, so a row EXISTS long before the sentence is finished, and the
 * harness was reading the model mid-word.
 *
 * The nonce is what exposed it. A check asking "does it remember" would have been satisfied by
 * `zephyr-21d688` and gone green on a racy harness — and the race would have surfaced later as
 * a flake in something else, which is the expensive way to find it.
 *
 * `turnsFor` increments in `onTurnEnd`, so this waits for the provider to say the turn is
 * finished rather than guessing from the arrival of output. §2.1: if the protocol reports it,
 * do not infer it.
 */
async function ask(host: SessionHost, id: AgentId, prompt: string): Promise<string> {
    const turnsBefore = host.turnsFor(id);
    host.prompt(id, prompt);

    const finished = await until(() => host.turnsFor(id) > turnsBefore, 180_000);
    if (!finished) console.log('    (the turn did not end within 180s — reading what arrived)');

    return host
        .rowsFor(id)
        .filter((r) => r.event.kind === 'message' && r.event.speaker === 'agent')
        .map((r) => (r.event.kind === 'message' ? r.event.text : ''))
        .join(' ');
}

async function main(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'genie2-resume-'));
    // A token no model can guess, and no two runs share.
    const nonce = `zephyr-${randomUUID().slice(0, 8)}`;
    console.log(`\ngenie2 live RESUME check — userData ${dir}\n  the token is ${nonce}\n`);

    try {
        // The first run of the app.
        const first = openApp(dir);
        await first.registry.load({ name: 'live', healthy: true });
        await first.registry.addWorkspace({ id: 'live', path: dir });
        const record = await first.registry.register({
            workspaceId: 'live',
            provider: 'claude',
            name: 'rememberer',
        });

        const started = first.host.start(record, dir);
        check(started.ok, '1. a real session starts', JSON.stringify(started));

        const ackd = await ask(
            first.host,
            record.id,
            `Remember this token exactly: ${nonce}. Reply with only the word OK.`,
        );
        check(ackd.length > 0, '2. the provider answered the first turn', ackd.slice(0, 60));

        const captured = await until(() => Boolean(first.registry.find(record.id)?.threadId), 20_000);
        const threadId = first.registry.find(record.id)?.threadId ?? null;
        check(captured && Boolean(threadId), '3. the provider’s session id was CAPTURED', String(threadId));

        first.host.stopAll();

        /*
         * A RESTART: a new Registry and a new SessionHost over the same directory, reading
         * `agents.json` off disk. Asserting the first registry's in-memory copy would prove a
         * setter ran — which was already true in the build where every restart silently lost
         * the conversation.
         */
        const second = openApp(dir);
        await second.registry.load({ name: 'live', healthy: true });
        const reread = second.registry.find(record.id);
        check(
            Boolean(threadId) && reread?.threadId === threadId,
            '4. and SURVIVED the restart, read back off disk',
            String(reread?.threadId),
        );

        const restarted = second.host.start(reread ?? record, dir);
        check(restarted.ok, '5. the agent starts again, resuming that thread', JSON.stringify(restarted));

        const recalled = await ask(
            second.host,
            record.id,
            'What was the exact token I asked you to remember? Reply with only the token.',
        );
        check(
            recalled.includes(nonce),
            '6. THE MODEL STILL REMEMBERS — the conversation survived',
            recalled.slice(0, 80),
        );

        second.host.stopAll();

        /*
         * THE NEGATIVE CONTROL.
         *
         * A fresh agent, no stored thread, asked the same question. It must NOT know the token.
         *
         * Without this, check 6 passes on a build where resume does nothing and the two turns
         * merely shared a process — exactly the build this file exists to catch. An absence
         * claim needs a positive control; a presence claim needs this.
         */
        const third = openApp(dir);
        await third.registry.load({ name: 'live', healthy: true });
        const fresh = await third.registry.register({
            workspaceId: 'live',
            provider: 'claude',
            name: 'stranger',
        });
        check(fresh.threadId === null, '7. the control agent has no thread id at all', String(fresh.threadId));

        third.host.start(fresh, dir);
        const stranger = await ask(
            third.host,
            fresh.id,
            'What was the exact token I asked you to remember? Reply with only the token, or NONE if I never did.',
        );
        check(
            !stranger.includes(nonce),
            '8. CONTROL: an agent with no thread does NOT know the token',
            stranger.slice(0, 80),
        );

        third.host.stopAll();
    } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 20 });
    }

    console.log('');
    if (failures.length > 0) {
        console.error(`RESUME CHECK FAILED — ${failures.length}:`);
        for (const f of failures) console.error(`  ${f}`);
        process.exit(1);
    }
    console.log('RESUME CHECK PASSED — a conversation started, was stored, and came back after a restart.\n');
}

await main();
