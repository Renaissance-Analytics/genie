; THE LAUNCHER'S INSTALLER (Tynn #1058 L3; the envelope's .ai/plans/genie-2-host-split-2026-10-31.md, "Launcher build
; spec"). electron-builder builds it from a folder that holds Genie.exe (the launcher, native/launcher) and packages\ (the
; client, browser and host packages of this release, each with its signed manifest): scripts/build-track-packages.mjs
; `installer`. It is today's installer shape: the same appId and folder (%LOCALAPPDATA%\Programs\Genie), one click, per
; user, never elevated, so every shortcut, pinned taskbar item and Run value that names Genie.exe now names the launcher.
;
; THE BARE INSTALL, AND THE LAUNCHER'S WINDOW. The install screens (choose, installing, ready) are the owner's direction C,
; "Wish Orb", rendered in WebView2. NSIS cannot host a webview for its install step cleanly, so this installer only puts
; the launcher and its packages in place and opens Genie: the launcher, finding nothing installed and packages\ beside it,
; shows those screens itself (native/launcher/src/ui.rs), installs from packages\ and removes it, so the NSIS folder holds
; the launcher alone. The choice is the launcher's: client + local host (the default) or Genie only.
;
; AUTOMATED (and electron-updater's silent run): Genie-setup.exe /S [/PROFILE=both|client] shows nothing; the launcher
; installs the packages here (`Genie.exe install --from`), checking each signature and every file exactly as a download
; is, and a launcher that refuses fails the install with its words.
;
; THE UNINSTALL: only a real one (an update also runs the old uninstaller over the folder) asks the launcher to stop the
; host gracefully and remove the code root. The data root (~\.genie) is kept, as it always was.

!include LogicLib.nsh
!include FileFunc.nsh

!ifndef BUILD_UNINSTALLER
  Var GenieProfile

  !macro customInit
    StrCpy $GenieProfile "both"
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/PROFILE=" $R1
    ${ifNot} ${Errors}
      ${if} $R1 == "client"
        StrCpy $GenieProfile "client"
      ${elseif} $R1 == "both"
        StrCpy $GenieProfile "both"
      ${else}
        MessageBox MB_ICONSTOP "/PROFILE= is both or client, not $R1." /SD IDOK
        SetErrorLevel 2
        Quit
      ${endif}
    ${endif}
  !macroend
!endif

!macro customInstall
  ; Genie and Genie (doctor mode) in the Start menu, both the launcher (the owner, 2026-10-13: "two shortcuts, normal and
  ; doctor"); electron-builder makes the first.
  CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME} (doctor mode).lnk" "$appExe" "--doctor" "$appExe" 0 "" "" "Open Genie in doctor mode: only genie runs, to diagnose and repair this install"
  ClearErrors
  ${if} ${Silent}
    DetailPrint "Installing Genie's programs ($GenieProfile)..."
    ; THE BRIDGE (Tynn #1058 L9): electron-updater runs this silently over the single app, whose window has just closed.
    ; The launcher's card says what is happening until its client window is up, never a blank desktop.
    ${if} ${isUpdated}
      Exec '"$INSTDIR\Genie.exe" moving-card'
    ${endif}
    nsExec::ExecToLog '"$INSTDIR\Genie.exe" install --profile $GenieProfile --from "$INSTDIR\packages" --yes'
    Pop $0
    RMDir /r "$INSTDIR\packages"
    ${if} $0 != 0
      SetErrorLevel 3
      Abort "Genie's programs could not be installed (the launcher answered $0)."
    ${endif}
  ${endif}
  ; Otherwise packages\ stays for the launcher's first run, which the installer starts now (its run-after-finish).
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog '"$INSTDIR\Genie.exe" uninstall --yes'
    Pop $0
  ${endif}
  Delete "$SMPROGRAMS\${SHORTCUT_NAME} (doctor mode).lnk"
!macroend
