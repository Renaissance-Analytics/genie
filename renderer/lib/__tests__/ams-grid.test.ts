import { describe, expect, it } from 'vitest';
import { amsAgentCard, splitAmsSpecs } from '../ams-grid';

describe('AMS sidebar grid', () => {
    const terminal = (id: string, agent?: string) => ({
        id,
        label: agent ? `${agent} worker` : 'shell',
        meta: agent ? { agent, whisper_purpose: 'frontend' } : {},
    }) as never;

    it('separates configured agent terminals from ordinary panels', () => {
        const result = splitAmsSpecs([terminal('a', 'claude'), terminal('t')]);
        expect(result.agents.map((spec) => spec.id)).toEqual(['a']);
        expect(result.panels.map((spec) => spec.id)).toEqual(['t']);
    });

    it('keeps running and active as independent states', () => {
        expect(amsAgentCard(terminal('a', 'codex'), { running: true, active: false })).toMatchObject({
            name: 'frontend',
            provider: 'codex',
            running: true,
            active: false,
        });
    });
});
