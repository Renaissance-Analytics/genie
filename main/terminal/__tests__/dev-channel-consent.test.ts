import { describe, expect, it } from 'vitest';
import { devChannelConsentReply, AGENTINBOX_CHANNEL_ENTRY } from '../dev-channel-consent';

/**
 * Genie answers its OWN development-channel warning, and nothing else.
 *
 * `--dangerously-load-development-channels` is the only flag that registers a
 * custom channel (the approved allowlist is Anthropic-curated and ours is not
 * on it), and it stops on a full-screen warning that a human must accept on
 * every launch. There is no flag, env var or settings key that pre-accepts it:
 * the installed CLI carries no `channelsAccepted`-style record anywhere, and
 * `--dangerously-skip-permissions` does not cover it.
 *
 * The owner's instruction was to keep the channel and remove the friction. The
 * only lever left is the one Genie already holds: it OWNS the pty it launched,
 * it is the party that added the flag, and the channel being warned about is
 * its own local adapter — not something downloaded off the internet, which is
 * what the warning exists to stop ("Do not use this option to run channels you
 * have downloaded off the internet").
 *
 * So this answers that one dialog, and the matching is deliberately narrow:
 *
 *  - the warning must be the development-channel warning, by its title;
 *  - the channels it lists must be EXACTLY Genie's own entry.
 *
 * A warning naming any other channel — one the user added by hand, one a
 * plugin brought in — is left for the human. Auto-accepting a security prompt
 * is only defensible for the prompt you caused yourself, so the test that
 * matters most here is the one that REFUSES.
 */

const WARNING = [
    'WARNING: Loading development channels',
    '--dangerously-load-development-channels is for local channel development only.',
    'Do not use this option to run channels you have downloaded off the internet.',
    'Please use --channels to run a list of approved channels.',
    '',
    `Channels: ${AGENTINBOX_CHANNEL_ENTRY}`,
    '',
    '❯ 1. I am using this for local development',
    '  2. Exit',
].join('\n');

describe('answering our own development-channel warning', () => {
    it('accepts the warning when it names only our channel', () => {
        expect(devChannelConsentReply(WARNING)).toBe('accept');
    });

    it('survives the ANSI and redraw noise a real pty delivers', () => {
        // The buffer is raw pty output, not clean lines: Ink repaints, so the
        // text arrives wrapped in escape sequences and often twice.
        const noisy = `[2J[H${WARNING.replace(/\n/g, '[0m\r\n[36m')}[0m`;

        expect(devChannelConsentReply(noisy)).toBe('accept');
    });

    /* ── the refusals, which are the point ─────────────────────────────── */

    it('REFUSES a warning that names a channel we did not add', () => {
        const foreign = WARNING.replace(
            `Channels: ${AGENTINBOX_CHANNEL_ENTRY}`,
            'Channels: server:someone-elses-channel',
        );

        expect(devChannelConsentReply(foreign)).toBe(null);
    });

    it('REFUSES when our channel is listed ALONGSIDE another', () => {
        // The dangerous shape: ours is there, so a lazy "does it mention us"
        // check would accept — and quietly consent to the other one too.
        const mixed = WARNING.replace(
            `Channels: ${AGENTINBOX_CHANNEL_ENTRY}`,
            `Channels: ${AGENTINBOX_CHANNEL_ENTRY}, server:someone-elses-channel`,
        );

        expect(devChannelConsentReply(mixed)).toBe(null);
    });

    it('REFUSES a different prompt that happens to mention our channel', () => {
        // The MCP-server consent dialog names the same server. It is a
        // different decision and is not ours to make.
        const mcpConsent = [
            '2 new MCP servers found in this project',
            'Select any you wish to enable.',
            '',
            '❯ [✔] genie',
            `  [✔] ${AGENTINBOX_CHANNEL_ENTRY.replace('server:', '')}`,
            '  Enable selected',
        ].join('\n');

        expect(devChannelConsentReply(mcpConsent)).toBe(null);
    });

    it('REFUSES the folder-trust prompt', () => {
        const trust = [
            'Quick safety check: Is this a project you created or one you trust?',
            '❯ No, exit',
            '  Yes, I trust this folder',
        ].join('\n');

        expect(devChannelConsentReply(trust)).toBe(null);
    });

    it('REFUSES ordinary output, and an empty buffer', () => {
        expect(devChannelConsentReply('')).toBe(null);
        expect(devChannelConsentReply('$ npm test\nall good\n')).toBe(null);
    });

    /**
     * POSITIVE CONTROL on the refusals above. Every one of them passes against
     * a function that returns `null` unconditionally — which would also mean
     * the warning is never answered and the friction never removed. The accept
     * cases at the top are what prove it can say yes; this pins that the
     * refusals differ from them by the CHANNEL LIST and nothing else.
     */
    it('POSITIVE CONTROL: the refusals differ from the accept only in the channel named', () => {
        const foreign = WARNING.replace(
            `Channels: ${AGENTINBOX_CHANNEL_ENTRY}`,
            'Channels: server:someone-elses-channel',
        );

        expect(devChannelConsentReply(WARNING)).toBe('accept');
        expect(devChannelConsentReply(foreign)).toBe(null);
        // Same title, same buttons, same everything else.
        expect(foreign).toContain('WARNING: Loading development channels');
        expect(foreign).toContain('I am using this for local development');
    });
});
