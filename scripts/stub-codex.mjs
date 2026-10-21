#!/usr/bin/env node
/**
 * A STUB CODEX APP SERVER — enough of the real protocol to park a real approval.
 *
 * ## Why this exists
 *
 * "No approval has ever been seen on screen" was an unproven item on this build's status, and
 * it could not be closed by a unit test: producing one needs a provider that sends permission
 * requests. `ClaudeDriver.permissionRequests` is `false` in prism-acp 0.6.1 — claude does not
 * send them over ACP yet — and `CodexDriver`'s is `true`. There is no codex binary in the
 * smoke container.
 *
 * So this speaks the App Server's newline-framed stdio JSON-RPC, well enough for the REAL
 * `CodexDriver` to complete its handshake and hand a REAL `PermissionRequest` to the session.
 * Nothing is mocked above this process: the driver, the session, the host, the bridge, the
 * registry and the UI are all the shipping code.
 *
 * ## It is a BINARY, not a hook
 *
 * Genie points at it the way it would point at any provider install — the same
 * `GENIE2_CODEX_BINARY` a user with a non-standard path would set. **The product behaves
 * identically**, which is the distinction the previous build got wrong: its `GENIE_E2E` env
 * var short-circuited the single-instance lock, so the suite tested an application that
 * behaved differently from the shipped one.
 *
 * ## What it deliberately does NOT do
 *
 * It is not a codex emulator and must never grow into one. It answers four frames and asks one
 * question. Anything it cannot answer it says so about, loudly, on stderr — a stub that
 * silently ignores an unexpected frame would make a protocol change look like a UI bug.
 */

const THREAD_ID = 'stub_thread_0001';
const TURN_ID = 'stub_turn_0001';

let nextId = 1000;

function send(frame) {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function respond(id, result) {
    send({ jsonrpc: '2.0', id, result });
}

function note(text) {
    // stderr, because stdout is the protocol channel. The driver surfaces these through
    // `onStderr`, so a human reading a failed smoke sees what the stub was doing.
    process.stderr.write(`[stub-codex] ${text}\n`);
}

/** The approval we park, once, on the first turn. */
let askedOnce = false;

function askForApproval() {
    const id = nextId++;
    note(`asking for approval (request ${id})`);
    send({
        jsonrpc: '2.0',
        id,
        // One of prism-acp's `APPROVAL_METHODS`. The driver maps it into a `PermissionRequest`
        // whose `toolCall.title` is the command — which is what the human reads.
        method: 'item/commandExecution/requestApproval',
        params: {
            threadId: THREAD_ID,
            itemId: 'stub_call_0001',
            command: 'php artisan migrate --force',
            cwd: process.cwd(),
            /**
             * **The decisions the server is willing to accept**, and the stub was silently
             * wrong without them.
             *
             * `prism-acp` builds the option list from this array — it does not assume a
             * default set, because what codex will accept depends on the request. With it
             * absent the driver added NO options and fell back to a lone `cancel`, so the
             * approval rendered on screen with one red button and no way to say yes.
             *
             * That read as a UI bug for a while. It was the stub not speaking the protocol,
             * which is the risk every stub carries: it is only as honest as the frames it
             * sends, and a thin one teaches you something false about the product.
             */
            availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
        },
    });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;

    // Newline-framed. A partial frame stays in the buffer until its newline arrives — reading
    // chunk boundaries as frame boundaries is the classic way a stdio protocol stub works on a
    // fast machine and hangs on a slow one.
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (line.length === 0) continue;

        let frame;
        try {
            frame = JSON.parse(line);
        } catch {
            note(`unparseable frame, ignoring: ${line.slice(0, 120)}`);
            continue;
        }

        handle(frame);
    }
});

function handle(frame) {
    const { id, method, result, error } = frame;

    // A RESPONSE to our approval request: the human answered, and this is the decision coming
    // back through the real driver. Saying so on stderr is what makes the round trip visible
    // when the smoke reports.
    if (method === undefined && id !== undefined) {
        note(`approval answered: ${JSON.stringify(result ?? error)}`);
        return;
    }

    switch (method) {
        case 'initialize':
            respond(id, { serverInfo: { name: 'stub-codex', version: '0.0.0' }, capabilities: {} });
            return;

        case 'initialized':
            // A notification; no id, no reply.
            return;

        case 'thread/start':
            respond(id, { thread: { id: THREAD_ID } });
            return;

        case 'thread/resume':
            respond(id, { thread: { id: THREAD_ID } });
            return;

        // The model list (prism-acp 0.22 `listModels` / `modelState`): two models the picker shows, one it must not —
        // Codex's own picker leaves `hidden` ones out, and so does prism.
        case 'model/list':
            respond(id, {
                data: [
                    { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', description: 'The everyday model', isDefault: true },
                    { id: 'gpt-6.1-sol-mini', model: 'gpt-6.1-sol-mini', displayName: 'GPT-6.1 Sol mini', description: 'Smaller and faster' },
                    { id: 'stub-hidden-model', model: 'stub-hidden-model', displayName: 'Hidden', hidden: true },
                ],
                nextCursor: null,
            });
            return;

        case 'turn/start': {
            respond(id, { turn: { id: TURN_ID } });

            // Ask ONCE. A stub that re-asks every turn would make "answering did nothing" and
            // "answering worked and it asked again" indistinguishable on screen.
            if (!askedOnce) {
                askedOnce = true;
                setTimeout(askForApproval, 50);
            }
            return;
        }

        default:
            if (id !== undefined) {
                // Answer rather than hang: an unanswered request blocks the driver forever, and
                // the symptom is an app that looks frozen rather than a stub that is incomplete.
                note(`unhandled request ${method} — answering empty so the driver does not hang`);
                respond(id, {});
            } else {
                note(`unhandled notification ${method}`);
            }
    }
}

process.stdin.on('end', () => process.exit(0));
note('ready');
