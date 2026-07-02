; Genie NSIS installer customization (electron-builder `nsis.include`).
;
; Opens an inbound Windows Firewall hole for the Mobile remote-control server so a
; paired phone on the tailnet can actually reach it. The server binds to the
; SPECIFIC Tailscale IP (never 0.0.0.0 / loopback), and Windows denies inbound by
; default, so WITHOUT this rule the phone's SYN to http://<tailnet-ip>:51718/m/ is
; silently dropped — "can't connect" for every Windows user.
;
; Port 51718 = DEFAULT_MOBILE_PORT (main/mobile/server.ts). The rule is scoped
; TIGHTLY to Tailscale's CGNAT range (100.64.0.0/10) so ONLY tailnet peers can
; reach the port — matching Genie's bind-to-tailnet security model; a LAN/WAN host
; is still refused. Named "Genie Mobile" so uninstall can remove exactly it.
;
; IMPORTANT — elevation: `netsh advfirewall` requires ADMINISTRATOR. This macro
; runs in the installer's token, which for Genie's `perMachine: false` (per-user,
; no-UAC, silent auto-update) NSIS installer is a STANDARD-USER token — so nsExec
; here fails silently (non-zero, ignored) and the rule is NOT added on a per-user
; install. It DOES take effect when Genie is installed elevated (perMachine / an
; admin context). The reliable per-user fix is the app adding the rule at runtime
; via a one-time UAC prompt (Settings -> Mobile "Allow through Windows Firewall").
; This macro is safe regardless: nsExec never prompts, so it can't break a silent
; update — it just no-ops when unelevated.

!macro customInstall
  ; Delete any stale rule first so re-install / update never stacks duplicates
  ; (idempotent), then add the tailnet-scoped inbound allow rule.
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Genie Mobile"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Genie Mobile" dir=in action=allow protocol=TCP localport=51718 remoteip=100.64.0.0/10 profile=any'
!macroend

!macro customUnInstall
  ; Remove the firewall rule on uninstall so nothing is left behind.
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Genie Mobile"'
!macroend
