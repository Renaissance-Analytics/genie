import { describe, expect, it } from 'vitest';
import { bindFailure, heldReason, listeningProcess } from '../src/main/front-door-port.js';

/**
 * WHO HOLDS :443 (S8) — the pure halves: Caddy's own words for a front-door port it could not bind, the reason Hosting
 * shows, and the holder's name from each OS's listener table (read-only commands, answered here by fakes).
 */

describe('Caddy’s words for a port it could not bind', () => {
    it('Windows and Linux "in use" → held, with the port', () => {
        expect(bindFailure('Error: loading initial config: loading new config: http app module: start: listening on 127.0.0.1:443: listen tcp 127.0.0.1:443: bind: Only one usage of each socket address (protocol/network address/port) is normally permitted.\r\n'))
            .toEqual({ port: 443, kind: 'held', words: 'Only one usage of each socket address (protocol/network address/port) is normally permitted.' });
        expect(bindFailure('{"level":"error","msg":"listen tcp 127.0.0.1:80: bind: address already in use"}\n')).toEqual({ port: 80, kind: 'held', words: 'address already in use' });
    });

    it('any other bind failure on :443/:80 is "refused", with Caddy’s words (a privileged port, a reserved range)', () => {
        expect(bindFailure('listen tcp 127.0.0.1:443: bind: permission denied')).toEqual({ port: 443, kind: 'refused', words: 'permission denied' });
        expect(bindFailure('listen tcp 127.0.0.1:443: bind: An attempt was made to access a socket in a way forbidden by its access permissions.')).toMatchObject({ port: 443, kind: 'refused' });
    });

    it('a site’s own Caddy on another port, and ordinary output, are not the front door’s failure', () => {
        expect(bindFailure('listen tcp 127.0.0.1:4101: bind: address already in use')).toBeNull();
        expect(bindFailure('{"level":"info","msg":"serving initial configuration"}')).toBeNull();
    });
});

describe('the reason Hosting shows', () => {
    it('names the port and, when the OS says, the process', () => {
        expect(heldReason(443, 'nginx')).toBe('another process holds :443 (nginx); https://<name>.gen in external browsers is off until it lets go — the in-app browser still works');
        expect(heldReason(80, null)).toBe('another process holds :80; https://<name>.gen in external browsers is off until it lets go — the in-app browser still works');
    });
});

describe('the holder’s name, per OS', () => {
    const answering = (stdout: string, exitCode = 0) => {
        const asked: Array<{ command: string; args: readonly string[] }> = [];
        return { asked, run: async (command: string, args: readonly string[]) => { asked.push({ command, args }); return { exitCode, stdout }; } };
    };

    it('Windows: the listener’s owning process; PID 4 is http.sys', async () => {
        const r = answering('httpd\r\n');
        expect(await listeningProcess('win32', 443, r.run)).toBe('httpd');
        expect(r.asked[0]!.command).toBe('powershell');
        expect(r.asked[0]!.args.at(-1)).toContain('Get-NetTCPConnection -State Listen -LocalPort 443');
        expect(r.asked[0]!.args.at(-1)).toContain("'System (http.sys)'");
        expect(await listeningProcess('win32', 443, answering('').run)).toBeNull();
    });

    it('Linux: ss’s users:(("name",…)); macOS: lsof’s c-line', async () => {
        expect(await listeningProcess('linux', 443, answering('LISTEN 0 511 127.0.0.1:443 0.0.0.0:* users:(("nginx",pid=812,fd=6))\n').run)).toBe('nginx');
        expect(await listeningProcess('linux', 443, answering('LISTEN 0 511 0.0.0.0:443 0.0.0.0:*\n').run)).toBeNull();
        expect(await listeningProcess('darwin', 443, answering('p812\ncnginx\n').run)).toBe('nginx');
    });

    it('a command that cannot run says nothing rather than guessing', async () => {
        expect(await listeningProcess('linux', 443, async () => { throw new Error('spawn ss ENOENT'); })).toBeNull();
    });
});
