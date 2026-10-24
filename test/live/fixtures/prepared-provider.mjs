// Native child for the launch-preparation gate. Speaks provider protocols; never calls a model or remote service.
import { writeFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const codex = process.argv.includes('app-server');
const provider = codex ? 'codex' : 'claude';
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\n');
const capture = (servers, privateFile = null) => writeFileSync(join(process.cwd(), `${provider}.json`), JSON.stringify({
    pid: process.pid, argv: process.argv, servers, privateMode: privateFile ? statSync(privateFile).mode & 0o777 : null,
    leakedPairing: process.env.GENIE_PAIRING_FIXTURE !== undefined,
}), { mode: 0o600 });

if (!codex) {
    const file = process.argv[process.argv.indexOf('--mcp-config') + 1];
    capture(JSON.parse(readFileSync(file, 'utf8')).mcpServers, file);
}
createInterface({ input: process.stdin }).on('line', (line) => {
    const frame = JSON.parse(line);
    if (codex) {
        if (frame.method === 'initialize') send({ jsonrpc: '2.0', id: frame.id, result: {} });
        else if (frame.method === 'thread/start') {
            capture(frame.params.config.mcp_servers);
            send({ jsonrpc: '2.0', id: frame.id, result: { thread: { id: 'prepared-native-thread' } } });
        } else if (frame.id !== undefined) send({ jsonrpc: '2.0', id: frame.id, result: {} });
    } else if (frame.type === 'control_request') {
        send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id,
            response: frame.request.subtype === 'initialize' ? { models: [{ value: 'fixture', displayName: 'Fixture', description: 'No model is called' }] } : {},
        } });
    }
});
