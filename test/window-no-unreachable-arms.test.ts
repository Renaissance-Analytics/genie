import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * NOTHING IN THE WINDOW OPENS WHAT GENIE-HOST OWNS (Tynn #594, host split P6, forward-only). Since #415 a window with no host
 * stops, so an arm for "no host" can never run. Only a test that composes alone opens these, from its own helper.
 */
const code = (path: string) => readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('source', () => {
    const main = code('src/main/main.ts');
    const compose = code('src/main/compose.ts');

    it.each([
        ['chat drafts', /ChatDraftStore\.open\(/],
        ['Take over', /new TakeOverHost\(/],
        ['the Tynn account', /TynnAccount\.open\(/],
        ['the GitHub account', /GithubAccount\.open\(/],
        ['the workstation', /new WorkstationService\(/],
        ['the keyring', /LinuxKeyring\.open\(/],
        ['the keychain', /new Keychain\(\)/],
        ['remote access', /remoteListener\(/],
        ['the relay host', /startRelayHost\(/],
        ['the relay member', /openRelayMember\(/],
        ['a connect grant', /mintConnectGrant\(/],
        ['its own relay channels', /relayChannels/],
        ['the process book', /ProcessBook\.open\(/],
        ['the process scheduler', /new ProcessScheduler\(/],
        ['the inbox wake', /wireInboxPush\(/],
        ['composed own stores', /composed\.own/],
    ])('the window opens no %s of its own', (_name, pattern) => {
        expect(main).not.toMatch(pattern);
    });

    it.each([
        ['settings', /SettingsStore\.open\(/],
        ['agent stores', /openAgentStores\(/],
        ['flows', /FlowStore\.open\(/],
        ['a flows engine', /startFlowsEngine\(/],
        ['a process supervisor', /new ProcessSupervisor\(/],
        ['an approval queue', /new ApprovalQueue\(/],
        ['remote devices on disk', /DeviceStore\.open\(/],
    ])('compose opens no %s of its own', (_name, pattern) => {
        expect(compose).not.toMatch(pattern);
    });

    it('CONTROL: the patterns read the real sources, and the host’s are what the window uses', () => {
        expect(main).toMatch(/agentEngineLink\.client\.remoteAccess\(\)/);
        expect(main).toMatch(/agentEngineLink\.client\.relayHost\(\)/);
        expect(compose).toMatch(/input\.agentStores/);
        expect(code('src/main/genie-host.ts')).toMatch(/ProcessBook\.open\(/);
    });
});
