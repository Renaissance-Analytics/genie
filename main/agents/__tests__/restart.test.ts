import { describe, expect, it } from 'vitest';
import { restartProviderForSpec } from '../restart';

describe('agent restart provider', () => {
    it('uses the current workstation provider for Genie OSA', () => {
        expect(restartProviderForSpec({ agent: 'claude', system: true }, { agent_default: 'codex' })).toBe('codex');
    });

    it('keeps an ordinary workspace agent on its saved provider', () => {
        expect(restartProviderForSpec({ agent: 'claude' }, { agent_default: 'codex' })).toBe('claude');
    });
});
