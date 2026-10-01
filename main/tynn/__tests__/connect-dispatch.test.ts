import { describe, expect, it, vi } from 'vitest';
import { dispatchConnectLink } from '../connect-dispatch';

/**
 * WHAT HAPPENS TO A LINK SOMEBODY PASTED INTO "Connect to…".
 *
 * The classifier says WHICH kind it is; this says what to DO with each, and the
 * split matters for a reason that is easy to get wrong in a click handler:
 *
 *  - an INVITE has to leave Genie. It is redeemed by a signed-in person on
 *    Tynn's own page, and until somebody accepts it this machine holds no
 *    entitlement at all — there is nothing for Genie to act on.
 *  - a `genie://` link must NOT leave Genie. `shell:open-external` deliberately
 *    refuses any protocol that is not http(s), and rightly so: handing arbitrary
 *    schemes to the OS is how a paste turns into a launched application. It is
 *    handled INTERNALLY, by the same `handleGenieUrl` the OS protocol handler
 *    uses, so a pasted link and a clicked one take one code path.
 *
 * Routing either one the other way fails silently, which is the worst outcome
 * for a box whose entire job is "this did or did not work".
 */
function deps() {
    return {
        openExternal: vi.fn(async () => ({ ok: true })),
        openGenieUrl: vi.fn(async () => {}),
    };
}

const TYNN = 'https://tynn.ai';

describe('dispatchConnectLink', () => {
    it('sends an invite OUT to the browser', async () => {
        const d = deps();
        const out = await dispatchConnectLink('https://tynn.ai/invites/accept/tok', TYNN, d);

        expect(d.openExternal).toHaveBeenCalledWith('https://tynn.ai/invites/accept/tok');
        expect(d.openGenieUrl).not.toHaveBeenCalled();
        expect(out.ok).toBe(true);
        expect(out.note).toMatch(/accept/i);
    });

    it('keeps a genie:// link INSIDE Genie', async () => {
        // `shell:open-external` refuses non-http(s) by design, so routing this
        // outward would do nothing at all and say nothing about it.
        const d = deps();
        const out = await dispatchConnectLink('genie://workstation/open?id=wst-1', TYNN, d);

        expect(d.openGenieUrl).toHaveBeenCalledWith('genie://workstation/open?id=wst-1');
        expect(d.openExternal).not.toHaveBeenCalled();
        expect(out.ok).toBe(true);
    });

    it('refuses what it does not recognise, with the classifier’s reason', async () => {
        const d = deps();
        const out = await dispatchConnectLink('https://evil.example/invites/accept/x', TYNN, d);

        expect(out.ok).toBe(false);
        expect(out.note).toMatch(/tynn\.ai/i);
        expect(d.openExternal).not.toHaveBeenCalled();
        expect(d.openGenieUrl).not.toHaveBeenCalled();
    });

    it('reports a browser that refused to open', async () => {
        // `openExternal` answering `{ok:false}` is the guard rejecting the URL.
        // Telling the user "accept it there" when no page opened is the silent
        // failure this whole surface exists to avoid.
        const d = { ...deps(), openExternal: vi.fn(async () => ({ ok: false })) };
        const out = await dispatchConnectLink('https://tynn.ai/invites/accept/tok', TYNN, d);

        expect(out.ok).toBe(false);
        expect(out.note).toMatch(/could not open/i);
    });

    it('never throws when the handler does', async () => {
        // The caller is a click handler in a flyout; an exception here takes the
        // panel down over a bad paste.
        const d = {
            ...deps(),
            openGenieUrl: vi.fn(async () => {
                throw new Error('no session');
            }),
        };
        const out = await dispatchConnectLink('genie://workstation/open?id=w', TYNN, d);

        expect(out.ok).toBe(false);
        expect(out.note).toContain('no session');
    });
});
