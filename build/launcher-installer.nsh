; THE LAUNCHER'S INSTALLER (Tynn #1058 L3; the envelope's .ai/plans/genie-2-host-split-2026-10-31.md, "Launcher build
; spec"). electron-builder builds it from a folder that holds Genie.exe (the launcher, native/launcher) and packages\ (the
; client, browser and host packages of this release, each with its signed manifest): scripts/build-track-packages.mjs
; `installer`. It is today's installer shape: the same appId and folder (%LOCALAPPDATA%\Programs\Genie), one click, per
; user, never elevated, so every shortcut, pinned taskbar item and Run value that names Genie.exe now names the launcher.
;
; THE CHOICE (the owner, 2026-11-25): this computer runs Genie's host (client + local host, the default), or client only.
; It is the one page before the install, skipped on an update (electron-updater runs the installer silent, and a silent
; install shows no page). Automated: Genie-setup.exe /S [/PROFILE=both|client].
;
; THE INSTALL: the launcher installs the packages into the code root (%LOCALAPPDATA%\Genie), checking each signature and
; every file exactly as a download is (`Genie.exe install --from`), and the packages folder is removed, so the NSIS
; folder holds the launcher alone. A launcher that refuses fails the install with its words.
;
; THE UNINSTALL: only a real one (an update also runs the old uninstaller over the folder) asks the launcher to stop the
; host gracefully and remove the code root. The data root (~\.genie) is kept, as it always was.

!include LogicLib.nsh
!include FileFunc.nsh

!ifndef BUILD_UNINSTALLER
  !include nsDialogs.nsh

  Var GenieProfile
  Var GenieProfileBoth
  Var GenieProfileClient

  ; electron-builder's one-click installer has one hook for a page before the install: licensePage. skipPageIfUpdated has
  ; just defined MUI_PAGE_CUSTOMFUNCTION_PRE for it; this page runs that function itself, and the define is spent here so
  ; it never reaches the install page after it.
  !macro licensePage
    !ifdef MUI_PAGE_CUSTOMFUNCTION_PRE
      !define GENIE_SKIP_IF_UPDATED ${MUI_PAGE_CUSTOMFUNCTION_PRE}
      !undef MUI_PAGE_CUSTOMFUNCTION_PRE
    !endif
    Page custom genieProfilePage genieProfileLeave
  !macroend

  Function genieProfilePage
    !ifdef GENIE_SKIP_IF_UPDATED
      Call ${GENIE_SKIP_IF_UPDATED}
    !endif
    ${if} ${isUpdated}
      Abort
    ${endif}
    !insertmacro MUI_HEADER_TEXT "How this computer runs Genie" "You can make this computer a host later."
    nsDialogs::Create 1018
    Pop $0
    ${if} $0 == error
      Abort
    ${endif}
    ${NSD_CreateRadioButton} 0 4u 100% 12u "This computer runs Genie's host (recommended)"
    Pop $GenieProfileBoth
    ${NSD_CreateLabel} 14u 18u 94% 24u "Your agents, terminals and sites run here, and keep running when Genie's window is closed. Genie's window can also connect to your other hosts."
    Pop $0
    ${NSD_CreateRadioButton} 0 52u 100% 12u "Client only"
    Pop $GenieProfileClient
    ${NSD_CreateLabel} 14u 66u 94% 24u "Only Genie's window is installed. It connects to hosts on your other computers; nothing runs here when it is closed."
    Pop $0
    ${if} $GenieProfile == "client"
      ${NSD_Check} $GenieProfileClient
    ${else}
      ${NSD_Check} $GenieProfileBoth
    ${endif}
    ; The one page before the install: its button says what it does.
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:Install"
    nsDialogs::Show
  FunctionEnd

  Function genieProfileLeave
    ${NSD_GetState} $GenieProfileClient $0
    ${if} $0 == ${BST_CHECKED}
      StrCpy $GenieProfile "client"
    ${else}
      StrCpy $GenieProfile "both"
    ${endif}
  FunctionEnd

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
  DetailPrint "Installing Genie's programs ($GenieProfile)..."
  nsExec::ExecToLog '"$INSTDIR\Genie.exe" install --profile $GenieProfile --from "$INSTDIR\packages" --yes'
  Pop $0
  ${if} $0 != 0
    RMDir /r "$INSTDIR\packages"
    MessageBox MB_ICONSTOP "Genie's programs could not be installed (the launcher answered $0; its words are above). Nothing was changed in Genie's programs folder." /SD IDOK
    SetErrorLevel 3
    Abort "Genie's programs could not be installed."
  ${endif}
  RMDir /r "$INSTDIR\packages"
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog '"$INSTDIR\Genie.exe" uninstall --yes'
    Pop $0
  ${endif}
  Delete "$SMPROGRAMS\${SHORTCUT_NAME} (doctor mode).lnk"
!macroend
