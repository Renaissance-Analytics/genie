// Native child for the launch-preparation gate. Speaks provider protocols; never calls a model or remote service.
import { writeFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';

const codex = process.argv.includes('app-server');
const provider = codex ? 'codex' : 'claude';
const inherited = { tynn: { url: 'https://inherited.invalid/mcp', bearer_token_env_var: 'LEGACY_TYNN_TOKEN' }, other: { command: 'user-server' } };
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\n');
const capture = (servers, privateFile = null, config = {}) => {
    const entry = servers.tynn;
    const enabled = entry !== undefined && entry.enabled !== false;
    const binding = codex ? entry?.bearer_token_env_var : undefined;
    const auth = !enabled ? null : binding ? `Bearer ${process.env[binding] ?? ''}` : (entry.headers ?? entry.http_headers)?.Authorization;
    writeFileSync(join(process.cwd(), `${provider}.json`), JSON.stringify({
        pid: process.pid, argv: process.argv, serverNames: Object.keys(servers), tynnUrl: entry?.url, tynnEnabled: enabled,
        authSha256: typeof auth === 'string' ? createHash('sha256').update(auth).digest('hex') : null,
        privateMode: privateFile ? statSync(privateFile).mode & 0o777 : null,
        bearerExcluded: binding ? config.shell_environment_policy?.exclude?.includes(binding) === true : null,
        shellSnapshotDisabled: config.features?.shell_snapshot === false,
        permissionHooksPresent: (config.hooks?.PreToolUse?.length ?? 0) > 0,
        leakedPairing: process.env.GENIE_PAIRING_FIXTURE !== undefined,
    }), { mode: 0o600 });
};

if (!codex) {
    const mcpIndex = process.argv.indexOf('--mcp-config');
    const file = mcpIndex < 0 ? null : process.argv[mcpIndex + 1];
    const settingsIndex = process.argv.indexOf('--settings');
    const settings = settingsIndex < 0 ? {} : JSON.parse(readFileSync(process.argv[settingsIndex + 1], 'utf8'));
    const servers = { ...inherited, ...(file ? JSON.parse(readFileSync(file, 'utf8')).mcpServers : {}) };
    for (const denied of settings.deniedMcpServers ?? []) servers[denied.serverName] = { ...servers[denied.serverName], enabled: false };
    capture(servers, file, settings);
}
createInterface({ input: process.stdin }).on('line', (line) => {
    const frame = JSON.parse(line);
    if (codex) {
        if (frame.method === 'initialize') send({ jsonrpc: '2.0', id: frame.id, result: {} });
        else if (frame.method === 'config/read') send({ jsonrpc: '2.0', id: frame.id, result: { config: {
            mcp_servers: inherited,
            shell_environment_policy: { inherit: 'core', exclude: ['KEEP_EXCLUDED'] },
        } } });
        else if (frame.method === 'thread/start') {
            capture({ ...inherited, ...frame.params.config.mcp_servers }, null, frame.params.config);
            send({ jsonrpc: '2.0', id: frame.id, result: { thread: { id: 'prepared-native-thread' } } });
        } else if (frame.id !== undefined) send({ jsonrpc: '2.0', id: frame.id, result: {} });
    } else if (frame.type === 'control_request') {
        send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id,
            response: frame.request.subtype === 'initialize' ? { models: [{ value: 'fixture', displayName: 'Fixture', description: 'No model is called' }] } : {},
        } });
    }
});
