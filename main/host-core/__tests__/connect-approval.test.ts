import { describe, expect, it } from 'vitest';
import { connectApproval, type ConnectApprovalInput } from '../connect-approval';

/**
 * EASY-CONNECT — does an arriving guest need the owner's say-so?
 *
 * The owner's words, listing it among the controls on a share link: *"Easy-Connect
 * (needs machine user approval to connect or not)"*. Today there is no gate at
 * all: anyone holding a share connects straight through, and the first the owner
 * knows about it is a name appearing on the connected-users list.
 *
 * TWO INPUTS, and the relationship between them is the whole reason this is a
 * tested function rather than an `if` at the socket:
 *
 *  - the MACHINE's standing answer — "ask me before anyone connects";
 *  - the LINK's own flag, chosen when it was minted.
 *
 * The machine wins when it is stricter, and NEVER when it is laxer. A link minted
 * with easy-connect on must not be a way to walk past a machine that asked to be
 * asked — otherwise the machine setting is advice, and the person it protects is
 * whoever did not mint the link.
 *
 * The OWNER is never gated. A prompt the owner has to answer to reach their own
 * computer is a lockout, and the approval UI is itself on that computer.
 */
const base: ConnectApprovalInput = {
    principalType: 'tynn-user',
    machineRequiresApproval: false,
    linkRequiresApproval: false,
    alreadyApproved: false,
};

describe('connectApproval', () => {
    it('lets a guest straight in when nothing asks for approval', () => {
        // Today's behaviour, kept: Easy-Connect OFF on both sides is the easy path.
        expect(connectApproval(base).decision).toBe('allow');
    });

    it('holds a guest when the LINK asked for approval', () => {
        expect(connectApproval({ ...base, linkRequiresApproval: true }).decision).toBe('ask');
    });

    it('holds a guest when the MACHINE asked for approval', () => {
        expect(connectApproval({ ...base, machineRequiresApproval: true }).decision).toBe('ask');
    });

    it('a lax LINK cannot walk past a strict MACHINE', () => {
        // THE rule. If a link could opt out of the machine's own requirement, the
        // setting would protect nobody except the person who minted the link.
        expect(
            connectApproval({
                ...base,
                machineRequiresApproval: true,
                linkRequiresApproval: false,
            }).decision,
        ).toBe('ask');
    });

    it('never gates the owner, whatever is switched on', () => {
        // A prompt the owner must answer to reach their own computer is a lockout
        // — and the approval UI lives on that computer.
        expect(
            connectApproval({
                ...base,
                principalType: 'owner',
                machineRequiresApproval: true,
                linkRequiresApproval: true,
            }).decision,
        ).toBe('allow');
    });

    it('does not ask twice for a guest already approved', () => {
        // Approval is per GUEST, not per socket. A dashboard that opens a second
        // connection must not raise a second prompt, and a reconnect after a
        // dropped network must not either — that is how an approval gate becomes
        // something people switch off.
        expect(
            connectApproval({
                ...base,
                machineRequiresApproval: true,
                alreadyApproved: true,
            }).decision,
        ).toBe('allow');
    });

    it('says WHY it is asking, so the prompt can name the reason', () => {
        // The owner sees this. "Someone wants to connect" with no reason is a
        // dialog people learn to dismiss.
        expect(connectApproval({ ...base, linkRequiresApproval: true }).reason).toMatch(/link/i);
        expect(connectApproval({ ...base, machineRequiresApproval: true }).reason).toMatch(
            /this computer|machine/i,
        );
    });

    it('treats a paired DEVICE as a guest, not as the owner', () => {
        // POSITIVE CONTROL for the owner exemption: it must key on being the
        // OWNER, not on "not a tynn user". A paired phone is somebody holding a
        // credential, and the gate exists for exactly that case.
        expect(
            connectApproval({
                ...base,
                principalType: 'device',
                machineRequiresApproval: true,
            }).decision,
        ).toBe('ask');
    });
});
