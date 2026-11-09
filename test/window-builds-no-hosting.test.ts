import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE WINDOW BUILDS NO HOSTING, APP-INBOX DOOR OR TRUST STATE OF ITS OWN (Tynn #584, host split P6, forward-only). genie-host
 * owns all three; a window with no host has already stopped and said so (Tynn #415).
 */
const code = (path: string) => readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('source', () => {
    const main = code('src/main/main.ts');
    const compose = code('src/main/compose.ts');

    it('compose cannot build its own hosting (and with it, its own trust state)', () => {
        expect(compose).not.toMatch(/composeHosting\(/);
        expect(compose).not.toMatch(/import \{[^}]*\bcomposeHosting\b/);
    });

    it('nothing in the app composes alone: only tests do, from their own helper', () => {
        expect(compose).not.toMatch(/export async function composeServices/);
        expect(main).not.toMatch(/composeServices/);
    });

    it('the window always reads the host’s hosting', () => {
        expect(main).toMatch(/\bhosting: agentEngineLink\.client\.hosting\(\)/);
        expect(main).not.toMatch(/\.\.\.\(agentEngineLink \? \{ hosting:/);
    });

    it('the window opens no app-inbox door and holds no app-inbox keys', () => {
        expect(main).not.toMatch(/AppInboxKeys/);
        expect(main).not.toMatch(/startAppInboxServer/);
        expect(main).not.toMatch(/new AppInboxService/);
    });

    it('CONTROL: the patterns read the real sources', () => {
        expect(main).toMatch(/agentEngineLink\.client\.appInbox\(\)/);
        expect(compose).toMatch(/input\.hosting/);
        expect(code('src/main/genie-host.ts')).toMatch(/composeHosting\(/);
    });
});
