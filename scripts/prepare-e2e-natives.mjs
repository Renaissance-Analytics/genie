// Prepare native modules for the E2E suite, which runs inside ELECTRON.
//
// better-sqlite3 needs nothing here any more. From v13 it is an N-API addon that
// ships prebuilt binaries inside the package (`prebuilds/<platform>-<arch>.node`),
// and an N-API binary loads under Node and Electron alike. This script used to
// fetch an Electron-ABI prebuild before every run, because `npm test` had rebuilt
// it for Node's ABI and Electron could no longer dlopen it — that whole dance, and
// the `prebuild-install` dependency it relied on, went away with v13.
//
// What remains is node-pty, which is still ABI-specific and is not rebuilt here
// (it already matches Electron from install).
import { restoreNodePtyConpty } from './node-pty-conpty.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// node-pty's ConPTY support files, when a native rebuild has been through here.
//
// The postinstall already repairs this (scripts/node-pty-conpty.mjs explains the
// whole mechanism), so on a freshly installed tree this is a no-op. It stays here
// because the E2E suite is the one place that FINDS the damage: it boots the real
// app and spawns real ptys, so a tree repaired at install time and re-broken since
// by a hand-run `electron-rebuild` would otherwise reach the suite as four
// mysterious failures about panels with no terminals in them.
//
// Unlike the postinstall this one is FATAL when the repair does not take: a gate
// that runs against a node-pty which cannot spawn proves nothing.
restoreNodePtyConpty(root, (m) => console.log(`[e2e] ${m}`));
