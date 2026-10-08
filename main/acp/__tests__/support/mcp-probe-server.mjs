/**
 * A MINIMAL MCP SERVER, for proving an ACP agent can reach one.
 *
 * `agent-spec.ts` claims an ACP child *"gets the genie MCP server for free: the CLI reads the
 * workspace's `.mcp.json`, and the child runs in that cwd."* That is a claim about external
 * behaviour with no test behind it, and the protocol's mandatory finish (`imDone`) depends on
 * it — an agent that cannot call it stalls the work in silence.
 *
 * So this server exists to be called. It is deliberately NOT the genie server: pointing a test
 * at that would reach the real rig, and a tool call there is a real side effect. This one
 * exposes a single tool whose only action is to TOUCH A FILE, which makes the proof an artifact
 * on disk rather than a line of prose in a transcript — the same discipline that caught the
 * permission defect, where a denied turn and a successful one produced identical frames.
 *
 * JSON-RPC 2.0 over newline-delimited stdio, which is what MCP's stdio transport is. Only the
 * three methods a tool call actually needs are implemented; anything else gets a proper
 * method-not-found so a mismatch reads as a refusal rather than a hang.
 */

import fs from 'node:fs';

const MARKER = process.env.MCP_PROBE_MARKER;

const TOOL = {
    name: 'probe_ping',
    description:
        'Confirm this MCP server is reachable. Call it with no arguments when asked to ping the probe.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

function send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
    send({ jsonrpc: '2.0', id, result: value });
}

let buffer = '';

process.stdin.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    // Newline-delimited: a partial frame stays in the buffer rather than being parsed as one.
    for (;;) {
        const cut = buffer.indexOf('\n');
        if (cut === -1) break;
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (line.length === 0) continue;

        let frame;
        try {
            frame = JSON.parse(line);
        } catch {
            // stdout is the protocol; a diagnostic there would corrupt the stream it reports on.
            process.stderr.write(`[mcp-probe] unparsable frame\n`);
            continue;
        }

        const { id, method } = frame;

        // A notification has no id and takes no reply — answering one is a protocol error.
        if (id === undefined || id === null) continue;

        if (method === 'initialize') {
            result(id, {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'genie-acp-probe', version: '1.0.0' },
            });
            continue;
        }

        if (method === 'tools/list') {
            result(id, { tools: [TOOL] });
            continue;
        }

        if (method === 'tools/call') {
            const name = frame.params?.name;
            if (name !== TOOL.name) {
                send({
                    jsonrpc: '2.0',
                    id,
                    error: { code: -32602, message: `no such tool: ${String(name)}` },
                });
                continue;
            }
            // THE ARTIFACT. Written before replying, so a marker on disk means the tool really
            // ran rather than that the agent said it did.
            if (MARKER) {
                try {
                    fs.writeFileSync(MARKER, 'called', 'utf8');
                } catch (err) {
                    process.stderr.write(`[mcp-probe] could not write marker: ${err.message}\n`);
                }
            }
            result(id, { content: [{ type: 'text', text: 'pong' }] });
            continue;
        }

        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    }
});

// Exit when the client closes the pipe, rather than becoming the orphan class that has already
// cost this machine real memory.
process.stdin.on('end', () => process.exit(0));
