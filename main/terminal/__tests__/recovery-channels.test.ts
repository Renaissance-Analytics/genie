import { describe, it, expect } from 'vitest';
import { TERMINAL_RECOVER_CHANNEL, TERMINAL_RECOVERY_STATUS_CHANNEL } from '../recovery-channels';

/**
 * The recovery IPC channel strings are the single source of truth shared by the
 * main-side broadcast (genie-adapter) and the preload listener (genie#203). This
 * pins their VALUES so a change is deliberate; terminal-recovery.spec (E2E) proves
 * both sides are actually wired to these constants end to end.
 */
describe('recovery channels', () => {
    it('are the stable ipc channel names the renderer listens on', () => {
        expect(TERMINAL_RECOVER_CHANNEL).toBe('terminal:recover');
        expect(TERMINAL_RECOVERY_STATUS_CHANNEL).toBe('terminal:recovery-status');
    });
});
