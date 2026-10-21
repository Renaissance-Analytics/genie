#!/usr/bin/env node
/**
 * A STUB CLAUDE CODE — enough of its stream-json control protocol to answer the model list.
 *
 * ## Why this exists
 *
 * The owner, 2026-10-21: "make sure that the model selection for agents is using actual available options from the
 * providers. For example, I do not even see fable as an option." Genie now asks the provider (prism-acp's `listModels`,
 * Claude's control `initialize`). Whether Genie launches the RIGHT binary with the right options to ask it cannot be
 * settled by a fake at the port: something has to be spawned and answer. This is that something, and the real
 * `claude` never runs in a test.
 *
 * Like `stub-codex.mjs`, it is a BINARY Genie is pointed at the way a user with a non-standard install would point it
 * (`GENIE2_CLAUDE_BINARY`). The product behaves identically.
 *
 * ## What it deliberately does NOT do
 *
 * It is not a Claude emulator. It answers `initialize` (and acknowledges `set_model`) and says, on stderr, about
 * anything else. Its initialize answer carries an ACCOUNT EMAIL on purpose, because the real one does (prism-acp,
 * 2026-10-21): it is what lets a test prove Genie never surfaces it.
 */

const STUB_ACCOUNT_EMAIL = 'person@example.com';

const MODELS = [
    { value: 'default', displayName: 'Default (recommended)', description: 'Use the default model', resolvedModel: 'claude-opus-5-5' },
    { value: 'fable', displayName: 'Fable', description: 'Fable for long-running work', resolvedModel: 'claude-fable-5-1' },
    { value: 'haiku', displayName: 'Haiku', description: 'Fastest for quick answers', resolvedModel: 'claude-haiku-5-5' },
];

function send(frame) {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function note(text) {
    process.stderr.write(`[stub-claude] ${text}\n`);
}

function handle(frame) {
    if (frame?.type !== 'control_request') {
        note(`ignoring a ${String(frame?.type)} frame`);
        return;
    }
    const id = frame.request_id;
    const subtype = frame.request?.subtype;
    if (subtype === 'initialize') {
        send({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { models: MODELS, account: { email: STUB_ACCOUNT_EMAIL } } } });
        return;
    }
    if (subtype === 'set_model') {
        send({ type: 'control_response', response: { subtype: 'success', request_id: id, response: {} } });
        return;
    }
    note(`unhandled control request ${String(subtype)} — answering an error so the caller does not hang`);
    send({ type: 'control_response', response: { subtype: 'error', request_id: id, error: `stub-claude does not handle ${String(subtype)}` } });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
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
process.stdin.on('end', () => process.exit(0));
note('ready');
