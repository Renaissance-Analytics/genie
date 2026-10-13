; GENIE'S START-MENU SHORTCUTS: Genie, and Genie in doctor mode (the owner, 2026-10-13: "two shortcuts, normal and
; doctor"). electron-builder makes the normal one ($SMPROGRAMS\${SHORTCUT_NAME}.lnk); these documented hooks add the
; doctor one beside it -- the same executable with --doctor (genie only; Genie's configuration and database are not
; opened) -- and remove it on uninstall. $appExe is set by electron-builder before customInstall runs.

!macro customInstall
  CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME} (doctor mode).lnk" "$appExe" "--doctor" "$appExe" 0 "" "" "Open Genie in doctor mode: only genie runs, to diagnose and repair this install"
  ClearErrors
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\${SHORTCUT_NAME} (doctor mode).lnk"
!macroend
