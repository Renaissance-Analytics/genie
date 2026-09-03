import { describe, expect, it } from 'vitest';
import { restartProviderForSpec } from '../restart';

describe('agent restart provider', () => {
    it('uses the current workstation provider for the workstation operator', () => {
        expect(
            restartProviderForSpec(
                { agent: 'claude', agent_id: 'genie:workstation' },
                { agent_default: 'codex' },
            ),
        ).toBe('codex');
    });

    it('keys on the operator IDENTITY, not on where its spec lives', () => {
        // `meta.system` marks System-Workspace panels and global processes too.
        // Keying on it made "which TUI does a restart use" a question about a
        // spec's address rather than about whose spec it is.
        expect(
            restartProviderForSpec(
                { agent: 'claude', ...({ system: true } as Record<string, unknown>) },
                { agent_default: 'codex' },
            ),
        ).toBe('claude');
    });

    it('keeps an ordinary workspace agent on its saved provider', () => {
        expect(restartProviderForSpec({ agent: 'claude' }, { agent_default: 'codex' })).toBe('claude');
    });
});
