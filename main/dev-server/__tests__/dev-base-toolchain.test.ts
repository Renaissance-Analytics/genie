import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEV_BASE_TOOLCHAIN, GENIE_DEV_BASE_IMAGE } from '../images';

/**
 * WHAT THE DEV BASE IMAGE GIVES YOU — and a guard so the answer stays true.
 *
 * The workstation Dev Server page has to say which language runtimes a
 * workspace's containers come with, because the alternative is a user opening a
 * terminal in the sandbox to run `node --version`. Asking the image itself
 * would mean starting a container (and pulling several gigabytes on a machine
 * that has not got it yet) to render a settings page, which is exactly the "no
 * downloads because you looked at it" rule the page is built around. So the
 * versions are a CONSTANT.
 *
 * A constant copied from a Dockerfile is a lie waiting to happen: the next
 * person to bump `GO_VERSION` has no reason to know this list exists, and the
 * page would then confidently name a Go that is not in the image. This test is
 * the reason they will find out — it reads the Dockerfile and fails on the
 * bump, naming the constant to update.
 *
 * PHP and Python are the exception and are handled the same way for the same
 * reason: they come from `apt` on the Debian base, so the `FROM` tag IS their
 * pin. The test asserts the base tag rather than an ARG, so changing the Debian
 * release also lands here.
 */

const DOCKERFILE = path.resolve(process.cwd(), 'main/dev-server/dev-base/Dockerfile');

function dockerfile(): string {
    return fs.readFileSync(DOCKERFILE, 'utf8');
}

/** The value of one `ARG NAME=value` line. */
function arg(name: string): string | null {
    const m = new RegExp(`^ARG ${name}=(.+)$`, 'm').exec(dockerfile());
    return m ? m[1]!.trim() : null;
}

const byId = (id: string) => DEV_BASE_TOOLCHAIN.find((t) => t.id === id);

describe('DEV_BASE_TOOLCHAIN', () => {
    it('names every runtime the image is built to provide', () => {
        expect(DEV_BASE_TOOLCHAIN.map((t) => t.id)).toEqual([
            'node',
            'php',
            'python',
            'go',
            'rust',
        ]);
        for (const entry of DEV_BASE_TOOLCHAIN) {
            expect(entry.label).toBeTruthy();
            expect(entry.version).toBeTruthy();
        }
    });

    it('matches the Dockerfile ARGs it claims to mirror', () => {
        // Fails on the NEXT bump of any of these, which is the entire point.
        expect(byId('node')?.version).toBe(arg('NODE_MAJOR'));
        expect(byId('go')?.version).toBe(arg('GO_VERSION'));
        expect(byId('rust')?.version).toBe(arg('RUST_VERSION'));
    });

    it('pins PHP and Python to the Debian base tag they actually come from', () => {
        // These are apt packages, so the FROM line is their version pin. If the
        // base moves off trixie, PHP 8.4 / Python 3.13 stop being true.
        expect(dockerfile()).toMatch(/^FROM debian:trixie-slim$/m);
        expect(byId('php')?.version).toBe('8.4');
        expect(byId('python')?.version).toBe('3.13');
        for (const id of ['php', 'python']) {
            expect(byId(id)?.source).toBe('debian:trixie-slim');
        }
    });

    it('carries the package managers that come with each runtime', () => {
        // A Node without pnpm, or a Python without uv, is a different answer to
        // "can I run this repo here" — so the page names them too.
        expect(byId('node')?.extras?.join(' ')).toContain(`pnpm ${arg('PNPM_VERSION')}`);
        expect(byId('node')?.extras?.join(' ')).toContain(`yarn ${arg('YARN_VERSION')}`);
        expect(byId('php')?.extras?.join(' ')).toContain(`Composer ${arg('COMPOSER_MAJOR')}`);
        expect(byId('python')?.extras?.join(' ')).toContain(`uv ${arg('UV_VERSION')}`);
    });

    it('describes the image the constants belong to', () => {
        // The versions are only true OF a specific image. Pinning the tag in the
        // same breath is what stops the list drifting onto a different one.
        expect(GENIE_DEV_BASE_IMAGE).toMatch(/^ghcr\.io\/.+:\d+$/);
    });
});
