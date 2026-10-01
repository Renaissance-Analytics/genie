import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SHARING IS REACHABLE — the guard for the failure this feature actually had.
 *
 * Every piece of workspace sharing worked: the Tynn endpoints, the main-side
 * module, the IPC handlers, and a complete panel. It was reachable only from two
 * clicks inside Workspace settings, and the owner's report was *"why can I still
 * not SHARE MY WORKSPACE"* — a feature that is built and cannot be found is a
 * feature that does not exist.
 *
 * Nothing in the type system catches that. `onShare` is optional on the menu (a
 * remote window must not offer it, because the link belongs to the workstation
 * that OWNS the workspace), so deleting the one line that passes it compiles
 * clean, every unit test stays green, and the item silently disappears again.
 *
 * So this reads the source. It is a blunt instrument and it is the right one
 * here: the claim is about a wire existing, not about behaviour, and the E2E
 * that could assert it is on CI-only hardware.
 */
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

const MENU = read('components/Master/ProjectContextMenu.tsx');
const MASTER = read('pages/master.tsx');
const MODAL = read('components/Master/ShareWorkspaceModal.tsx');

describe('the workspace right-click menu offers sharing', () => {
    it('has a Share workspace item', () => {
        expect(MENU).toMatch(/label="Share workspace…"/);
    });

    it('drives it from the onShare prop, not from a hard-coded handler', () => {
        // The menu is presentational everywhere else; a Share item that called
        // the API itself would be the one place the menu knew about Tynn.
        expect(MENU).toMatch(/onShare\?:\s*\(\)\s*=>\s*void/);
        expect(MENU).toMatch(/onShare\(\);/);
    });

    it('is actually passed one by master', () => {
        // THE line that was missing. Without it every assertion above still
        // passes and the item never renders, because `onShare` is optional.
        expect(MASTER).toMatch(/onShare:\s*\(\)\s*=>\s*setShareWsId\(ws\.id\)/);
    });

    it('opens the modal master holds state for', () => {
        expect(MASTER).toMatch(/<ShareWorkspaceModal/);
        expect(MASTER).toMatch(/const \[shareWsId, setShareWsId\]/);
    });

    it('withholds it in a remote window', () => {
        // A share link is scoped to the workstation that owns the workspace.
        // Minting one from a window driving somebody else's machine would hand
        // out a link to the wrong workspace on the wrong host.
        expect(MASTER).toMatch(/isRemoteWindow\(\)\s*\?\s*\{\}\s*:\s*\{\s*onShare/);
    });
});

describe('the Share modal mints through the real path', () => {
    it('calls the mint IPC with the capability AND the expiry', () => {
        // The expiry control is inert unless it reaches the call. Tynn has always
        // accepted `expires_in_days`; Genie never sent one, so every link expired
        // in a week whatever the picker said.
        expect(MODAL).toMatch(/mintShareLink\(workspace\.id,\s*\{/);
        expect(MODAL).toMatch(/capability,/);
        expect(MODAL).toMatch(/expiresInDays,/);
    });

    it('builds the expiry picker from the list main validates against', () => {
        // One list, so the control cannot offer a value the mint would refuse.
        expect(MODAL).toMatch(/SHARE_LINK_EXPIRY_CHOICES/);
    });

    it('never re-serves the URL from a list', () => {
        // The URL is the credential and exists for one moment — the mint
        // response. The modal must hold THAT, not re-read it from anywhere.
        expect(MODAL).not.toMatch(/listShareLinks/);
    });
});

const FLYOUT = read('components/Master/SharingFlyout.tsx');

/**
 * The GLOBAL half of the owner's sharing spec — the header icon that opens *"a
 * global overview of all shared workspaces and link lists with actions, plus
 * workstation sharing controls, plus a Connect to.. button"*.
 *
 * Guarded in source for the same reason as the right-click: `onShowSharing` is
 * optional on the title bar (a remote window must not offer it — the links
 * belong to the workstation that OWNS the workspaces), so deleting the one line
 * that passes it compiles clean and leaves no icon.
 */
describe('the Sharing flyout is reachable and complete', () => {
    it('has a header button', () => {
        expect(MASTER).toMatch(/aria-label="Sharing"/);
        expect(MASTER).toMatch(/<SharingFlyout/);
    });

    it('is actually passed a handler by master', () => {
        expect(MASTER).toMatch(/onShowSharing:\s*\(\)\s*=>\s*setSharingOpen/);
    });

    it('withholds it in a remote window', () => {
        expect(MASTER).toMatch(/isRemoteWindow\(\)\s*\n?\s*\?\s*\{\}\s*\n?\s*:\s*\{\s*onShowSharing/);
    });

    it('covers all three things the owner asked for', () => {
        expect(FLYOUT).toMatch(/Shared workspaces/);
        expect(FLYOUT).toMatch(/This workstation/);
        expect(FLYOUT).toMatch(/Connect to/);
    });

    it('offers revoke on every live link', () => {
        // The roster is the point of this surface: a link cannot be unsent, so
        // seeing it and killing it is the only control over one.
        expect(FLYOUT).toMatch(/revokeShareLink/);
    });

    it('mints workstation links through the workstation path, not the workspace one', () => {
        // The two take different arguments and only one can reach a workspace
        // the caller never named.
        expect(FLYOUT).toMatch(/mintWorkstationShareLink/);
        expect(FLYOUT).not.toMatch(/mintShareLink\(/);
    });

    it('routes a pasted link through MAIN, never opening it from the renderer', () => {
        // A `genie://` link must not go to `shell:open-external` — that refuses
        // non-http(s) by design, so routing it outward fails silently. Main hands
        // it to Genie's own protocol router instead.
        expect(FLYOUT).toMatch(/connectLink\(pasted\)/);
        expect(FLYOUT).not.toMatch(/openExternal/);
    });
});
