import type { ComponentProps } from 'react';
import TerminalPanel from './TerminalPanel';

/**
 * A first-class Floor surface for an AMS agent. The PTY remains the agent's live
 * transport, but the surrounding UX is deliberately agent chrome: identity,
 * purpose and provider styling, with no shell switcher that could accidentally
 * turn the saved agent into an ordinary terminal.
 */
export default function AgentPanel(props: ComponentProps<typeof TerminalPanel>) {
    const provider = String(props.spec.meta.agent ?? 'custom');
    const { style, ...terminalProps } = props;
    return (
        <div
            className={`agent-panel-shell agent-provider-${provider}`}
            data-agent-provider={provider}
            style={style}
        >
            <TerminalPanel {...terminalProps} surface="agent" />
        </div>
    );
}
