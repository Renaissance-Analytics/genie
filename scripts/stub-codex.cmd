@echo off
rem Run the stub app-server through node.
rem
rem `GENIE2_CODEX_BINARY` points here on Windows rather than at `stub-codex.mjs` directly:
rem prism-acp spawns with `shell: true` on win32 (the CVE-2024-27980 fix means Node refuses a
rem `.cmd` shim otherwise), and cmd.exe cannot execute a `.mjs` — it would hand the file to
rem whatever the machine has registered for that extension. A real npm-installed codex is a
rem `.cmd` for the same reason, so this is the SHAPE a user actually has.
rem
rem Keep this path free of spaces: `shell: true` does not quote the binary, so a spaced path
rem is split by cmd.exe and fails through `close` with exit 1 rather than through `error`.
node "%~dp0stub-codex.mjs" %*
