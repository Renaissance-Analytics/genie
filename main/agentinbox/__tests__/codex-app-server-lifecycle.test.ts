import { describe, expect, it } from 'vitest';
import {
    codexAppServerLaunch,
    codexRemoteTuiLaunch,
} from '../codex-app-server-lifecycle';

describe('Codex App Server lifecycle launch contracts', () => {
    it('authenticates the loopback App Server with a capability-token file', () => {
        const launch = codexAppServerLaunch({
            codexExecutable: 'codex',
            address: 'ws://127.0.0.1:47891',
            tokenFile: 'C:/private/codex-app.token',
        });

        expect(launch).toEqual({
            command: 'codex',
            args: [
                'app-server',
                '--listen',
                'ws://127.0.0.1:47891',
                '--ws-auth',
                'capability-token',
                '--ws-token-file',
                'C:/private/codex-app.token',
            ],
        });
        expect(JSON.stringify(launch)).not.toContain('plain-secret');
    });

    it('connects the visible Codex TUI through the authenticated remote address', () => {
        expect(codexRemoteTuiLaunch('codex --model gpt-5', 'ws://127.0.0.1:47891')).toBe(
            'codex --model gpt-5 --remote ws://127.0.0.1:47891 --remote-auth-token-env GENIE_CODEX_APP_TOKEN',
        );
    });

    it('does not add a second remote binding', () => {
        const command = 'codex --remote ws://127.0.0.1:1';
        expect(codexRemoteTuiLaunch(command, 'ws://127.0.0.1:2')).toBe(command);
    });
});
