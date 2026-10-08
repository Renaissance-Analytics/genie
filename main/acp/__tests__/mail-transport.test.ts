import { describe, expect, it, vi } from 'vitest';
import { acpMailSender, bindAcpMailTransport } from '../mail-transport';

/**
 * AN ACP SESSION IS THE AGENT'S MAIL TRANSPORT.
 *
 * ## The regression this closes, which making ACP the default CAUSED
 *
 * AgentInbox has exactly two harness-native transports: the Claude Channel (`pull` — a
 * bridge Claude Code spawns, which long-polls the durable inbox) and the Codex App Server
 * (`push` — Genie calls it). Both are properties of a provider's CLI, and the Claude one is
 * loaded only when the launch line carries
 * `--dangerously-load-development-channels`.
 *
 * An ACP session has no launch line. Claude's ACP launch is prism's adapter under node, with
 * no Claude Code flags at all — so the channel CANNOT bind for an ACP agent, and
 * `main/terminal/ipc.ts` now records that as a known `false` rather than leaving it unknown.
 *
 * Measured consequence: with ACP on by default and nothing in its place, every claude agent
 * silently lost its push transport. Mail still queued durably and the agent still found it on
 * its next `receive`, so nothing failed — it just stopped ARRIVING, which is the complaint
 * the owner has already raised once ("why the fuck are you not getting the agent inbox
 * pushes?"). A green suite would have reported this as fine.
 *
 * ## Why the ACP session is the better transport, not merely a replacement
 *
 * It is a `push`: Genie holds the pipe and the agent ACKs. The channel can only ever prove a
 * WRITE — its last hop is a JSON-RPC notification with no reply (genie#549) — and it depends
 * on a flag whose absence is silent. This depends on nothing but the session already running.
 */

const payload = (text: string) => ({ text });

describe('acpMailSender', () => {
    it('delivers mail as a PROMPT, which is what an ACP session accepts', async () => {
        const prompt = vi.fn(async () => ({ delivered: true, submitted: true }));
        await acpMailSender(prompt)(payload('you have mail'));
        expect(prompt).toHaveBeenCalledWith('you have mail');
    });

    it('THROWS when the session did not take it, so the binding is dropped', async () => {
        // The registry unbinds a push transport whose `send` rejects, and the message stays
        // queued. That is the whole fallback: resolving here would ACK mail the agent never
        // got, and the message would be marked delivered and never seen again.
        const prompt = vi.fn(async () => ({ delivered: false, submitted: false }));
        await expect(acpMailSender(prompt)(payload('lost'))).rejects.toThrow(/did not take/i);
    });

    it('propagates a transport error rather than swallowing it', async () => {
        const prompt = vi.fn(async () => {
            throw new Error('channel closed');
        });
        await expect(acpMailSender(prompt)(payload('x'))).rejects.toThrow('channel closed');
    });

    it('does not require SUBMITTED, because a prompt is not a keystroke', async () => {
        // `submitted` is a pty concept — the Enter after a bracketed paste. An ACP prompt is
        // one call: delivered is the only honest signal, and demanding the other would fail
        // every real delivery.
        const prompt = vi.fn(async () => ({ delivered: true, submitted: false }));
        await expect(acpMailSender(prompt)(payload('x'))).resolves.toBeUndefined();
    });
});

describe('bindAcpMailTransport', () => {
    const ports = (promptExists: boolean) => {
        const bound: Array<{ agentId: string; kind: string }> = [];
        return {
            bound,
            ports: {
                promptFor: () =>
                    promptExists ? async () => ({ delivered: true, submitted: true }) : null,
                bind: (agentId: string, kind: string) => {
                    bound.push({ agentId, kind });
                },
            },
        };
    };

    it('binds the agent as an acp-session transport', () => {
        const { bound, ports: p } = ports(true);
        expect(bindAcpMailTransport(p as never, { specId: 's1', agentId: 'a1' })).toBe(true);
        expect(bound).toEqual([{ agentId: 'a1', kind: 'acp-session' }]);
    });

    it('binds nothing when there is no live session to prompt', () => {
        // Binding a transport that cannot be called is the failure mode of the channel bug
        // wearing a new hat: AgentInbox would believe the mail was going somewhere.
        const { bound, ports: p } = ports(false);
        expect(bindAcpMailTransport(p as never, { specId: 's1', agentId: 'a1' })).toBe(false);
        expect(bound).toEqual([]);
    });

    it('binds nothing without an AgentInbox identity', () => {
        // The TWO IDS. The registry answers to the terminal's own `meta.agent_id`; binding
        // under a spec id would register a transport for an agent nobody addresses.
        const { bound, ports: p } = ports(true);
        expect(bindAcpMailTransport(p as never, { specId: 's1', agentId: null })).toBe(false);
        expect(bound).toEqual([]);
    });
});
