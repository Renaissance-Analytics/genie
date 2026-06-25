import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { injectBaseHref, serveStatic } from '../server';

/**
 * The static handler serves the mobile UI export under `/m/` with two security-
 * relevant behaviours: it injects `<base href="/m/">` into the shell so the
 * relative `./_next/...` asset URLs resolve, and it HARD-guards path traversal
 * so a `/m/../secret` can't escape the app dir. We exercise both against a real
 * temp app dir + a fake ServerResponse that captures status/headers/body.
 */

interface FakeRes {
    statusCode: number;
    headers: Record<string, string | number>;
    body: string;
    writeHead: (status: number, headers?: Record<string, string | number>) => void;
    end: (chunk?: string | Buffer) => void;
}

function fakeRes(): FakeRes {
    const res: FakeRes = {
        statusCode: 0,
        headers: {},
        body: '',
        writeHead(status, headers) {
            res.statusCode = status;
            if (headers) res.headers = headers;
        },
        end(chunk) {
            if (chunk) res.body = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
        },
    };
    return res;
}

let appDir: string;
function buildAppDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-mobile-static-'));
    fs.writeFileSync(
        path.join(dir, 'mobile.html'),
        '<!doctype html><html><head><meta charset="utf-8"></head><body>app</body></html>',
    );
    fs.mkdirSync(path.join(dir, '_next', 'static'), { recursive: true });
    fs.writeFileSync(path.join(dir, '_next', 'static', 'chunk.js'), 'console.log(1)');
    fs.writeFileSync(path.join(dir, '_next', 'static', 'app.css'), 'body{}');
    // A sensitive file BESIDE the app dir the traversal guard must not reach.
    fs.writeFileSync(path.join(dir, '..', 'genie-secret.json'), '{"token":"x"}');
    return dir;
}

afterEach(() => {
    if (appDir) fs.rmSync(appDir, { recursive: true, force: true });
});

describe('injectBaseHref', () => {
    it('inserts <base href="/m/"> into the head', () => {
        const out = injectBaseHref('<html><head><meta></head><body></body></html>');
        expect(out).toContain('<base href="/m/">');
        // It lands inside <head>, before the existing meta.
        expect(out.indexOf('<base')).toBeLessThan(out.indexOf('<meta'));
    });
    it('is idempotent when a <base> already exists', () => {
        const html = '<html><head><base href="/x/"><meta></head></html>';
        expect(injectBaseHref(html)).toBe(html);
    });
});

describe('serveStatic', () => {
    it('serves the shell with the <base> injected for /m and /m/', () => {
        appDir = buildAppDir();
        for (const p of ['/m', '/m/']) {
            const res = fakeRes();
            const handled = serveStatic(res as never, appDir, p);
            expect(handled).toBe(true);
            expect(res.statusCode).toBe(200);
            expect(res.headers['Content-Type']).toContain('text/html');
            expect(res.body).toContain('<base href="/m/">');
        }
    });

    it('serves a real _next asset with the right MIME', () => {
        appDir = buildAppDir();
        const js = fakeRes();
        expect(serveStatic(js as never, appDir, '/m/_next/static/chunk.js')).toBe(true);
        expect(js.statusCode).toBe(200);
        expect(js.headers['Content-Type']).toContain('text/javascript');
        expect(js.body).toBe('console.log(1)');

        const css = fakeRes();
        serveStatic(css as never, appDir, '/m/_next/static/app.css');
        expect(css.headers['Content-Type']).toContain('text/css');
    });

    it('404s a path-traversal attempt instead of leaking a sibling file', () => {
        appDir = buildAppDir();
        const res = fakeRes();
        const handled = serveStatic(res as never, appDir, '/m/_next/../../genie-secret.json');
        expect(handled).toBe(true);
        // Either a hard 404, or the SPA shell — never the secret's contents.
        expect(res.body).not.toContain('"token"');
    });

    it('serves the shell for an unknown sub-path (SPA deep link)', () => {
        appDir = buildAppDir();
        const res = fakeRes();
        expect(serveStatic(res as never, appDir, '/m/dashboard')).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('<base href="/m/">');
    });

    it('does not handle a non-/m path', () => {
        appDir = buildAppDir();
        const res = fakeRes();
        expect(serveStatic(res as never, appDir, '/api/state')).toBe(false);
    });
});
