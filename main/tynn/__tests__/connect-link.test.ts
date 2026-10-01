import { describe, expect, it } from 'vitest';
import { classifyConnectLink } from '../connect-link';

/**
 * WHAT SOMEBODY JUST PASTED INTO "Connect to…".
 *
 * The owner wants one box that takes *"any genie link"*, and there are two, which
 * resolve through completely different paths:
 *
 *  - a Tynn INVITE url, which has to be opened and redeemed by a signed-in
 *    person before this machine has any entitlement at all;
 *  - a `genie://workstation/open` DEEP LINK, which is what the redemption page
 *    hands back afterwards and which Genie can act on directly.
 *
 * Telling them apart is the whole job, and it is worth its own module because
 * the failure mode of guessing is bad in both directions: treating a deep link
 * as a url opens a browser for nothing, and treating a url as a deep link tries
 * to connect to a workstation whose id is a token.
 *
 * The third answer matters as much as the first two. "I do not recognise this"
 * has to be a sentence, not a silent no-op — the box is where somebody pastes
 * the wrong half of an email.
 */
describe('classifyConnectLink', () => {
    it('recognises a Tynn invite url', () => {
        expect(
            classifyConnectLink('https://tynn.ai/invites/accept/abc123', 'https://tynn.ai'),
        ).toEqual({
            kind: 'invite',
            url: 'https://tynn.ai/invites/accept/abc123',
        });
    });

    it('recognises an invite on whatever host Genie is pointed at', () => {
        // Genie runs against tynn.test and tynn.gen as well as production, and a
        // link minted by one of those is the one a developer actually pastes.
        expect(classifyConnectLink('https://tynn.test/invites/accept/t', 'https://tynn.test')).toEqual(
            { kind: 'invite', url: 'https://tynn.test/invites/accept/t' },
        );
    });

    it('recognises a workstation deep link', () => {
        expect(
            classifyConnectLink('genie://workstation/open?id=wst-1&name=AlphaR', 'https://tynn.ai'),
        ).toEqual({ kind: 'workstation', workstationId: 'wst-1', name: 'AlphaR' });
    });

    it('takes a deep link with no name', () => {
        expect(classifyConnectLink('genie://workstation/open?id=wst-1', 'https://tynn.ai')).toEqual({
            kind: 'workstation',
            workstationId: 'wst-1',
        });
    });

    it('trims what was pasted', () => {
        // Copying a link out of a chat window brings whitespace and newlines with
        // it, and a leading space is not a reason to tell somebody their link is
        // not a link.
        expect(
            classifyConnectLink('  https://tynn.ai/invites/accept/abc  \n', 'https://tynn.ai'),
        ).toEqual({ kind: 'invite', url: 'https://tynn.ai/invites/accept/abc' });
    });

    it('refuses an invite url on a DIFFERENT host', () => {
        // This box opens what it is given. Accepting any https url would make it
        // a way to get Genie to open an arbitrary page on somebody's behalf, and
        // a link to a Tynn that is not yours cannot be redeemed here anyway.
        const out = classifyConnectLink('https://evil.example/invites/accept/abc', 'https://tynn.ai');
        expect(out.kind).toBe('unknown');
        expect(out.kind === 'unknown' && out.reason).toMatch(/tynn\.ai/i);
    });

    it('refuses a url on the right host that is not an invite', () => {
        // POSITIVE CONTROL for the host check: matching the host is necessary and
        // not sufficient, or the box would open any page on Tynn.
        expect(classifyConnectLink('https://tynn.ai/projects/42', 'https://tynn.ai').kind).toBe(
            'unknown',
        );
    });

    it('refuses an invite url with no token', () => {
        expect(classifyConnectLink('https://tynn.ai/invites/accept/', 'https://tynn.ai').kind).toBe(
            'unknown',
        );
    });

    it('refuses a genie:// link that is not a workstation open', () => {
        // `genie://oauth/callback?token=…` is a real link of ours and carries a
        // session token. Pasting one here must not be treated as a connection.
        expect(
            classifyConnectLink('genie://oauth/callback?token=secret', 'https://tynn.ai').kind,
        ).toBe('unknown');
    });

    it('refuses a workstation deep link with no id', () => {
        expect(classifyConnectLink('genie://workstation/open', 'https://tynn.ai').kind).toBe(
            'unknown',
        );
    });

    it('says something useful about an empty box', () => {
        const out = classifyConnectLink('   ', 'https://tynn.ai');
        expect(out.kind).toBe('unknown');
        expect(out.kind === 'unknown' && out.reason).toBeTruthy();
    });

    it('does not throw on something that is not a url at all', () => {
        expect(classifyConnectLink('hello there', 'https://tynn.ai').kind).toBe('unknown');
        expect(classifyConnectLink('http://[', 'https://tynn.ai').kind).toBe('unknown');
    });
});
