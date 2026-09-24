# PTY host exit evidence

`<userData>/logs/host-service.log` records detached host exit code, signal,
monotonic uptime in milliseconds, PID, launch mode, script, and terminal count.
The count is the last-known HostClient mirror, including pending creates; it
survives the active-backend switch on socket loss. A host that never connected
has an unknown count. This is evidence, not proof of a crash's cause.

Spawn breadcrumbs precede the create request for agent terminals, renderer
terminals, and supervised processes. They contain only terminal ID, provider
and label, JSON-escaped onto one timestamped line. Reattaching to a live terminal
does not emit a new spawn breadcrumb. Commands, prompts and environment values
are not recorded.

The decoder names clean exit, signals and three known Windows statuses, preserving
raw code and signal alongside the description. Unknown statuses stay UNKNOWN.
Status meanings follow [Microsoft's NTSTATUS table](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55).

The exit observer covers both Genie-spawned detached branches while the spawning
Genie process lives. It cannot observe an inherited host after Genie restarts,
or a host launched by the OS service manager. No live host is restarted to enable
these diagnostics. [Node's unref documentation](https://nodejs.org/api/child_process.html#subprocessunref)
describes removal of the event-loop reference, not removal of event listeners.
A windowless detached Node probe confirmed delivery of exit code 23 after unref.

Local validation: listener and decoder tests were run red before implementation;
terminal unit tests and all three TypeScript checks pass. No local Electron or
Playwright launch was used. Full CI and VM E2E remain the release-facing checks.
