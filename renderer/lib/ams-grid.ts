import type { TerminalSpec } from './genie';

export function splitAmsSpecs(specs: TerminalSpec[]): {
    agents: TerminalSpec[];
    panels: TerminalSpec[];
} {
    return specs.reduce(
        (result, spec) => {
            result[spec.meta?.agent ? 'agents' : 'panels'].push(spec);
            return result;
        },
        { agents: [], panels: [] } as { agents: TerminalSpec[]; panels: TerminalSpec[] },
    );
}

export function amsAgentCard(
    spec: TerminalSpec,
    state: { running: boolean; active: boolean },
) {
    const purpose = typeof spec.meta?.whisper_purpose === 'string'
        ? spec.meta.whisper_purpose.trim()
        : '';
    return {
        name: purpose || spec.label,
        provider: spec.meta?.agent ?? 'custom',
        running: state.running,
        active: state.active,
    };
}
