import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { connectableWorkstations, setWorkstationRole } from '../src/main/tynn-network.js';
import { RoleChangeForm, TynnWorkstationRows } from '../src/renderer/components/ConnectMenu.js';

/**
 * THE PILOT / DRONE SWITCH (genie#1278 row W6; the owner, 2026-10-27: "this needs to be highly protected with the 2sa
 * actually enforced"). The role lives in Tynn; Tynn enforces the code on `PUT /api/v1/workstations/{id}/role
 * {role, code}` (owner only, never from a drone, a fresh TOTP every time, 5 a minute). Genie only collects the code and
 * says what Tynn answered. Tynn answers every unauthorized request with 404 and never says which reason, so Genie says
 * what the 404 can mean, plainly, with Retry.
 */

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('setWorkstationRole — asking Tynn', () => {
    it('PUTs the role and the code to the workstation, and answers with the role Tynn now holds', async () => {
        const asked: Array<{ path: string; method: string; body: unknown }> = [];
        const out = await setWorkstationRole(async (path, init) => { asked.push({ path, method: init.method, body: init.body }); return json(200, { workstation: { id: 'ws_a', role: 'drone' } }); }, 'ws_a', 'drone', ' 123 456 ');
        expect(asked).toEqual([{ path: '/api/v1/workstations/ws_a/role', method: 'PUT', body: { role: 'drone', code: '123456' } }]);
        expect(out).toEqual({ ok: true, role: 'drone' });
    });

    it('a code that is not six digits is never sent', async () => {
        let called = false;
        for (const code of ['', '12345', '1234567', 'abcdef']) {
            const out = await setWorkstationRole(async () => { called = true; return json(200, {}); }, 'ws_a', 'pilot', code);
            expect(out.ok, code).toBe(false);
        }
        expect(called).toBe(false);
    });

    it('404: Tynn does not say why, so Genie says what it can mean', async () => {
        const out = await setWorkstationRole(async () => json(404, {}), 'ws_a', 'pilot', '123456');
        expect(out.ok).toBe(false);
        if (!out.ok) {
            expect(out.reason).toContain('owner');
            expect(out.reason).toContain('sign in');
        }
    });

    it('422 two_factor_required: Tynn’s words, and that 2FA must be turned on', async () => {
        const out = await setWorkstationRole(async () => json(422, { error: 'two_factor_required', message: 'Turn on two-factor authentication in your Tynn account to change workstation roles.' }), 'ws_a', 'pilot', '123456');
        expect(out).toEqual({ ok: false, reason: 'Turn on two-factor authentication in your Tynn account to change workstation roles.', needsTwoFactor: true });
    });

    it('422 a wrong code, or a cloud machine made a pilot: Tynn’s own sentence', async () => {
        const bad = await setWorkstationRole(async () => json(422, { message: 'x', errors: { code: ['That authenticator code is not valid. Enter the current code from your authenticator app.'] } }), 'ws_a', 'pilot', '123456');
        expect(bad).toEqual({ ok: false, reason: 'That authenticator code is not valid. Enter the current code from your authenticator app.' });
        const cloud = await setWorkstationRole(async () => json(422, { errors: { role: ['A cloud workstation is always a drone.'] } }), 'ws_c', 'pilot', '123456');
        expect(cloud).toEqual({ ok: false, reason: 'A cloud workstation is always a drone.' });
    });

    it('429: too many tries, wait a minute', async () => {
        const out = await setWorkstationRole(async () => json(429, {}), 'ws_a', 'pilot', '123456');
        expect(out.ok === false && out.reason).toContain('minute');
    });

    it('Tynn unreachable: says so', async () => {
        const out = await setWorkstationRole(async () => { throw new Error('ECONNRESET'); }, 'ws_a', 'pilot', '123456');
        expect(out).toEqual({ ok: false, reason: 'Tynn could not be reached (ECONNRESET)' });
    });

    it('an answer without a known role is not a success', async () => {
        expect((await setWorkstationRole(async () => json(200, { workstation: { role: 'PILOT' } }), 'ws_a', 'pilot', '123456')).ok).toBe(false);
    });
});

describe('the list carries each workstation’s role from Tynn', () => {
    it('exactly pilot or drone, else unknown', async () => {
        const rows = [
            { id: 'a', name: 'a', status: 'active', is_local: true, connectable: true, source: 'owner', role: 'pilot' },
            { id: 'b', name: 'b', status: 'active', is_local: false, connectable: true, source: 'owner', role: 'drone' },
            { id: 'c', name: 'c', status: 'active', is_local: true, connectable: true, source: 'owner', role: 'admin' },
        ];
        const out = await connectableWorkstations(async () => json(200, { workstations: rows }), null);
        expect(out.ok && out.workstations.map((w) => w.role)).toEqual(['pilot', 'drone', null]);
    });
});

describe('the switch on each workstation (a pilot only)', () => {
    const rows = { ok: true as const, workstations: [
        { id: 'ws_desk', name: 'desk', active: true, connectable: true, local: true, source: 'owner', role: 'pilot' as const },
        { id: 'ws_cloud', name: 'cloud', active: true, connectable: true, local: false, source: 'owner', role: 'drone' as const },
        { id: 'ws_guest', name: 'pat', active: true, connectable: true, local: true, source: 'invite', role: 'pilot' as const },
    ] };
    const row = (html: string, id: string) => { const at = html.slice(html.indexOf(`data-tynn-workstation-row="${id}"`)); return at.slice(0, at.indexOf('</li>')); };

    it('each row shows its role as a glyph, named for a screen reader', () => {
        const html = renderToStaticMarkup(<TynnWorkstationRows list={rows} onOpenWorkstation={() => {}} onSetRole={async () => ({ ok: true, role: 'drone' })} />);
        expect(row(html, 'ws_desk')).toMatch(/data-workstation-role="pilot"[^>]*aria-label="Pilot"|aria-label="Pilot"[^>]*data-workstation-role="pilot"/);
        expect(row(html, 'ws_cloud')).toContain('data-workstation-role="drone"');
    });

    it('a pilot gets a real button on its own desktops; never on a cloud machine (always a drone) or one only shared with it', () => {
        const html = renderToStaticMarkup(<TynnWorkstationRows list={rows} onOpenWorkstation={() => {}} onSetRole={async () => ({ ok: true, role: 'drone' })} />);
        expect(row(html, 'ws_desk')).toMatch(/<button[^>]*data-action="change-role"/);
        expect(row(html, 'ws_cloud')).not.toContain('data-action="change-role"');
        expect(row(html, 'ws_guest')).not.toContain('data-action="change-role"');
    });

    it('CONTROL: not a pilot (no onSetRole) — no switch anywhere', () => {
        const html = renderToStaticMarkup(<TynnWorkstationRows list={rows} onOpenWorkstation={() => {}} />);
        expect(html).not.toContain('data-action="change-role"');
    });
});

describe('the code prompt: the code, Confirm, its step, then success or the reason with Retry', () => {
    const form = (state: Parameters<typeof RoleChangeForm>[0]['state'], code = '123456') =>
        renderToStaticMarkup(<RoleChangeForm to="drone" name="desk" code={code} state={state} onCode={() => {}} onConfirm={() => {}} onCancel={() => {}} />);

    it('says what will change, and asks for the authenticator code as a one-time code', () => {
        const html = form({ kind: 'idle' });
        expect(html).toContain('desk');
        expect(html).toMatch(/<input[^>]*data-role-code=""/);
        expect(html).toMatch(/autoComplete="one-time-code"|autocomplete="one-time-code"/);
        expect(html).toMatch(/inputMode="numeric"|inputmode="numeric"/);
    });

    it('Confirm is enabled only with six digits', () => {
        expect(form({ kind: 'idle' })).toMatch(/<button[^>]*data-action="confirm-role"(?![^>]*disabled="")[^>]*>/);
        expect(form({ kind: 'idle' }, '123')).toMatch(/<button[^>]*data-action="confirm-role"[^>]*disabled=""/);
    });

    it('working: the step, Confirm disabled', () => {
        const html = form({ kind: 'working', step: 'Asking Tynn…' });
        expect(html).toContain('Asking Tynn…');
        expect(html).toMatch(/<button[^>]*data-action="confirm-role"[^>]*disabled=""/);
    });

    it('done: says so', () => {
        expect(form({ kind: 'done', note: 'desk is now a drone' })).toContain('desk is now a drone');
    });

    it('failed: the reason, and Retry', () => {
        const html = form({ kind: 'failed', reason: 'That authenticator code is not valid.' });
        expect(html).toContain('That authenticator code is not valid.');
        expect(html).toMatch(/<button[^>]*data-action="retry-role"/);
    });
});

describe('wired', () => {
    const strip = (text: string): string => text.split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
    const main = strip(readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8'));
    const preload = strip(readFileSync(new URL('../src/main/preload.ts', import.meta.url), 'utf8'));
    const app = strip(readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8'));
    const account = strip(readFileSync(new URL('../src/main/tynn-account.ts', import.meta.url), 'utf8'));

    it('main asks Tynn, refusing first on a drone (the role it read from Tynn), then re-reads this machine’s role', () => {
        const handler = /ipcMain\.handle\('genie:tynn-workstation-role'([^]*?)\n {4}\}\);/.exec(main)?.[1] ?? '';
        expect(handler).toContain('droneRefusal(workstationRoleNow)');
        expect(handler).toContain('setWorkstationRole(');
        expect(handler.indexOf('droneRefusal')).toBeLessThan(handler.indexOf('setWorkstationRole('));
    });

    it('preload exposes it', () => {
        expect(preload).toMatch(/setRole: \(workstationId, role, code\) => ipcRenderer\.invoke\('genie:tynn-workstation-role', workstationId, role, code\)/);
    });

    it('the window offers the switch only when Tynn says this machine is a pilot', () => {
        expect(app).toMatch(/onSetRole: features\.remote\?\.tynnWorkstation\?\.role === 'pilot' \?/);
    });

    it('the Tynn session can PUT', () => {
        expect(account).toMatch(/type Method = [^;]*'PUT'/);
    });
});
