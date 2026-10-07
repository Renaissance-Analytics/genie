import { type ComponentProps } from 'react';
import TerminalPanel from './TerminalPanel';
import { agentTerminalSurface } from '../../lib/agent-chrome';
import {
    AgentChromeMenu,
    AgentHeaderActions,
    useAgentChromeMenu,
    type AgentChromeHandlers,
} from './AgentChrome';

/**
 * An agent's terminal tile on the Floor — what `AgentPanel` was, minus the duplicate.
 *
 * `AgentPanel` is gone (owner decision, 2026-10-07: share the chrome, and *"we don't need
 * the TUI agent support like we have it now"*). What it did that mattered is here or in
 * `AgentChrome`; what it did twice — the driver switcher, already canonical in Agent
 * settings → Driver — is not.
 *
 * `surface` comes from `agentTerminalSurface` rather than a hard-coded `"agent"`. That prop
 * is the safety property: `TerminalPanel` does `shells={surface === 'agent' ? [] : …}`, so an
 * agent tile offers no shells and the switcher cannot quietly turn a saved agent into an
 * ordinary terminal. Deriving it means a spec that is NOT an agent still gets its shells,
 * which a hard-coded value would have silently removed.
 */
type Props = ComponentProps<typeof TerminalPanel> &
    AgentChromeHandlers & {
        /** Flip this one tile to the paired, separate `<name>-slave` agent screen. */
        screenSwitch?: {
            label: string;
            name: string;
            target: 'sidecar' | 'driver';
            busy: boolean;
            onClick: () => void;
        } | null;
    };

export default function AgentTerminal(props: Props) {
    const { style, onAgentSettings, onRestartAgent, screenSwitch, ...terminalProps } = props;
    const provider = String(props.spec.meta.agent ?? 'custom');
    const menu = useAgentChromeMenu();
    const input = {
        spec: props.spec,
        onRestart: !!onRestartAgent,
        onSettings: !!onAgentSettings,
        screenSwitch: screenSwitch
            ? {
                  label: screenSwitch.label,
                  name: screenSwitch.name,
                  target: screenSwitch.target,
                  busy: screenSwitch.busy,
              }
            : null,
    };

    return (
        <div
            className={`agent-panel-shell agent-provider-${provider}`}
            data-agent-provider={provider}
            style={style}
            onContextMenu={menu.open}
        >
            <TerminalPanel
                {...terminalProps}
                surface={agentTerminalSurface(props.spec)}
                // The restart control rides in the panel's OWN actions row. It was once
                // absolutely positioned at a hard-coded `right: 72px` and overlapped the
                // panel's buttons — a fixed offset cannot survive the control set changing.
                headerActions={
                    <AgentHeaderActions
                        input={input}
                        onRestartAgent={onRestartAgent}
                        onScreenSwitch={screenSwitch?.onClick}
                    />
                }
            />
            <AgentChromeMenu
                menu={menu}
                input={input}
                onRestartAgent={onRestartAgent}
                onAgentSettings={onAgentSettings}
            />
        </div>
    );
}
