; Custom NSIS logic for the 3D Gen Studio Windows installer/uninstaller.
;
; Two independent overrides live here:
;   1. customRemoveFiles / customInit - directory-link (junction) safety.
;   2. customCheckAppRunning          - the "app is still running" check.
;
; WHY THE LINK PURGE EXISTS
; -------------------------
; electron-builder's stock uninstaller removes the app with a single
;   RMDir /r $INSTDIR
; (see node_modules/app-builder-lib/templates/nsis/uninstaller.nsh). NSIS's
; recursive delete does NOT check for reparse points: it walks straight THROUGH
; directory junctions and symlinks and deletes the contents of whatever they
; point at — on any drive. Anyone who relocates big folders with `mklink /J`
; (very common for ComfyUI models) and has such a link anywhere inside the
; install tree loses the link TARGET, not just the app.
;
; Reproduced against the exact toolchain we ship with (NSIS 3.0.4.1, the version
; electron-builder 25.x pins): a junction inside $INSTDIR pointing at a folder on
; another drive had its entire contents destroyed by `RMDir /r $INSTDIR`.
;
; The update path is affected too, and worse: un.atomicRMDir `Rename`s each entry
; into $PLUGINSDIR\old-install for rollback, and NSIS wipes $PLUGINSDIR
; recursively when it exits — which removed the link target directory outright.
;
; THE FIX
; -------
; Before anything recursive happens, walk the tree and remove any directory
; reparse point with a plain `RMDir` (no /r). That deletes the LINK and leaves
; the target untouched — verified. Once the tree contains no links, the stock
; recursive delete can only reach real app files.
;
; Defining `customRemoveFiles` replaces the vendor's whole delete block, so the
; atomic-rename rollback for updates is reproduced here rather than lost.
;
; `customInit` applies the same purge on the installer side. That is the only
; thing that can protect someone upgrading FROM a version whose uninstaller
; predates this fix, because the installer hands the old (unsafe) uninstaller the
; job of clearing the previous install.

!include LogicLib.nsh

; Number of links neutralized in this run, used to decide whether to tell the user.
Var /GLOBAL purgedLinkCount

; Generates PurgeLinks (installer) / un.PurgeLinks (uninstaller) from one body.
; Usage: Push "<absolute directory>" then Call ${UN}PurgeLinks
;
; Depth-first. For every child directory we ask the filesystem for its attributes
; and branch:
;   FILE_ATTRIBUTE_REPARSE_POINT (0x400) -> RMDir, i.e. unlink, never recurse
;   FILE_ATTRIBUTE_DIRECTORY     (0x010) -> recurse
; Attributes are read with GetFileAttributesW, which reports the link's own
; attributes and does not follow it. Broken links are still caught, because we
; test the attribute bits rather than asking whether the path is a directory.
;
; Files are deliberately left alone: DeleteFile on a file symlink removes the
; link and not its target, so the stock recursive delete is already safe there.
!macro GEN_PURGE_LINKS UN
Function ${UN}PurgeLinks
  Exch $R0        ; directory to scan (caller's $R0 goes to the stack)
  Push $R1        ; FindFirst handle
  Push $R2        ; current entry name
  Push $0         ; attributes (System::Call writes $0)
  Push $1         ; bit-test scratch

  FindFirst $R1 $R2 "$R0\*.*"
  ${Do}
    ${If} $R2 == ""
      ${ExitDo}
    ${EndIf}

    ${If} $R2 != "."
    ${AndIf} $R2 != ".."
      System::Call 'kernel32::GetFileAttributesW(w "$R0\$R2") i .r0'
      ${If} $0 <> -1                      ; -1 = INVALID_FILE_ATTRIBUTES
        IntOp $1 $0 & 0x400
        ${If} $1 <> 0
          DetailPrint "Removing directory link (its target is left intact): $R0\$R2"
          RMDir "$R0\$R2"
          IntOp $purgedLinkCount $purgedLinkCount + 1
        ${Else}
          IntOp $1 $0 & 0x10
          ${If} $1 <> 0
            Push "$R0\$R2"
            Call ${UN}PurgeLinks
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}

    FindNext $R1 $R2
  ${Loop}
  FindClose $R1

  Pop $1
  Pop $0
  Pop $R2
  Pop $R1
  Pop $R0         ; restores the caller's $R0 and drops the argument
FunctionEnd
!macroend

; ---------------------------------------------------------------------------
; "IS THE APP STILL RUNNING?" CHECK
; ---------------------------------------------------------------------------
; Defining customCheckAppRunning replaces the vendor macro _CHECK_APP_RUNNING
; (node_modules/app-builder-lib/templates/nsis/include/allowOnlyOneInstallerInstance.nsh),
; which both the installer (installSection.nsh) and the old version's
; uninstaller (un.onInit) call before touching any file.
;
; THE PROBLEM
; -----------
; Detection is by image name only:
;   tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq <app>.exe"
; and EVERY process the app creates carries that name: the Electron helpers
; (GPU, renderer, utility) and - the one that actually bites - the backend,
; which electron/main.cjs spawns as the app executable itself with
; ELECTRON_RUN_AS_NODE. The backend has no window, so it sits under "Background
; processes" where nobody looks.
;
; So users saw "3D Gen Studio is running" for an app they had closed, and the
; vendor loop then failed them twice over:
;   - its first kill attempt is a plain `taskkill` (no /f), which only posts
;     WM_CLOSE to top-level windows - a no-op against exactly the window-less
;     process that is blocking the install;
;   - when the single force attempt does not work either, it dead-ends on
;     "please close it manually", advice that cannot be followed for a process
;     with no window. Restarting Windows was the only way out.
;
; WHAT CHANGES
; ------------
;   - the graceful pass gets a real window to finish in (~3 s of polling)
;     instead of the vendor's 300 ms, so a visible app can shut its own children
;     down cleanly;
;   - the force pass then actually runs, repeatedly, instead of once;
;   - if force-killing still fails, Setup offers to retry with administrator
;     rights. A per-user install runs unelevated, so `taskkill /f` against an app
;     that was started as administrator returns "Access is denied" forever - the
;     elevated retry is the only thing short of a reboot that clears that;
;   - the last-resort dialog names the background process and the exact taskkill
;     command instead of "close it manually". English only: LangStrings are not
;     available this early in the script, so the localized $(appRunning) is still
;     used for the first prompt.

; taskkill against every process with the app's image name except this one.
; The per-user branch mirrors the vendor's: a per-user install must not (and
; cannot) touch another account's processes.
; _FLAGS is "" for the graceful pass (WM_CLOSE) or "/f" to terminate.
!macro APP_TASKKILL _FLAGS _SELF_PID _SCRATCH
  !ifdef INSTALL_MODE_PER_ALL_USERS
    nsExec::Exec `taskkill ${_FLAGS} /im "${APP_EXECUTABLE_FILENAME}" /fi "PID ne ${_SELF_PID}"`
  !else
    nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill ${_FLAGS} /im "${APP_EXECUTABLE_FILENAME}" /fi "PID ne ${_SELF_PID}" /fi "USERNAME eq %USERNAME%"`
  !endif
  ; nsExec pushes its exit code - dropping it here keeps the stack balanced.
  Pop ${_SCRATCH}
!macroend

!macro customCheckAppRunning
  ; $EXEFILE is this executable's own filename. If it matches, the "running app"
  ; is us (the portable build extracts and runs the app exe) - nothing to close.
  ${If} "$EXEFILE" != "${APP_EXECUTABLE_FILENAME}"
    Push $R0   ; FIND_PROCESS result: 0 = at least one matching process exists
    Push $R1   ; attempt counter
    Push $R2   ; our own pid - never a kill target
    Push $R3   ; scratch for nsExec exit codes

    System::Call 'kernel32::GetCurrentProcessId()i.R2'
    StrCpy $R1 0

    ${Do}
      !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
      ${If} $R0 != 0
        ${ExitDo}                 ; nothing named like the app is running
      ${EndIf}

      IntOp $R1 $R1 + 1

      ${If} $R1 == 1
        ; Ask first - a visible app may hold unsaved work. Silent installs and
        ; the app-initiated update path answer OK automatically.
        ${IfNot} ${isUpdated}
          MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK +2
            Quit
        ${EndIf}
        DetailPrint `Closing "${PRODUCT_NAME}"...`
        !insertmacro APP_TASKKILL "" $R2 $R3
        Sleep 1000
      ${ElseIf} $R1 <= 3
        ; Still the graceful window: the app is quitting and killing its own
        ; backend and Python services. Roughly 3 s in total.
        Sleep 1000
      ${ElseIf} $R1 <= 9
        ; Window-less leftovers ignore WM_CLOSE, so terminate them. Repeated,
        ; because a process can take a moment to actually disappear.
        ${If} $R1 == 4
          DetailPrint `Force-closing background processes of "${PRODUCT_NAME}"...`
        ${EndIf}
        !insertmacro APP_TASKKILL "/f" $R2 $R3
        Sleep 750
      ${Else}
        ; ~7 s of force-kills and it is still there. The usual reason taskkill
        ; cannot touch it: the app was started as administrator while this
        ; per-user Setup runs unelevated, so every attempt returns "Access is
        ; denied". One elevated taskkill fixes that; anything else (a process
        ; wedged in a driver call) needs the manual route below.
        MessageBox MB_YESNO|MB_ICONEXCLAMATION "${PRODUCT_NAME} is still running and Setup could not close it.$\r$\n$\r$\nThis usually means it was started with administrator rights, while Setup is running as the normal user.$\r$\n$\r$\nTry closing it as administrator? Windows will ask you to confirm." /SD IDNO IDYES tryElevated
        Goto askManual
      tryElevated:
        ; "runas" gives taskkill an admin token - one UAC prompt, no console flash.
        ; A cancelled prompt just leaves the process running; the loop comes back here.
        ExecShellWait "runas" "$SYSDIR\taskkill.exe" '/f /im "${APP_EXECUTABLE_FILENAME}" /fi "PID ne $R2"' SW_HIDE
        StrCpy $R1 3              ; back to the force-kill pass to confirm
        Goto stuckHandled
      askManual:
        ; Name the process and the exact command: "close it manually" is useless
        ; advice for something that has no window to close.
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${PRODUCT_NAME} could not be closed automatically.$\r$\n$\r$\nA process named $\"${APP_EXECUTABLE_FILENAME}$\" is still running. It may have no window, so it will not appear under Apps in the Task Manager: look for ${PRODUCT_NAME} under Background processes and end it there, or open a Command Prompt and run$\r$\n$\r$\n    taskkill /f /im $\"${APP_EXECUTABLE_FILENAME}$\"$\r$\n$\r$\nThen click Retry. If it still cannot be closed, restarting Windows always clears it." /SD IDCANCEL IDRETRY +2
          Quit
        StrCpy $R1 3              ; Retry: straight back to the force-kill pass
      stuckHandled:
      ${EndIf}
    ${Loop}

    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
  ${EndIf}
!macroend

!ifdef BUILD_UNINSTALLER

  !insertmacro GEN_PURGE_LINKS "un."

  ; Replaces the vendor delete block in Section un.install.
  !macro customRemoveFiles
    StrCpy $purgedLinkCount 0

    ; Sanity guard. $INSTDIR comes from the registry (InstallLocation), and a
    ; drive root or empty value would turn this section into a whole-volume wipe.
    StrLen $0 "$INSTDIR"
    ${If} "$INSTDIR" == ""
    ${OrIf} $0 < 4
      DetailPrint "Refusing to remove an implausible install directory: $INSTDIR"
    ${Else}
      ; Must happen before ANY recursive delete or Rename-into-$PLUGINSDIR.
      Push "$INSTDIR"
      Call un.PurgeLinks
      ${If} $purgedLinkCount <> 0
        DetailPrint "Neutralized $purgedLinkCount directory link(s) before uninstalling."
      ${EndIf}

      ; From here on this mirrors the vendor block, which is now safe to run.
      ${if} ${isUpdated}
        CreateDirectory "$PLUGINSDIR\old-install"

        Push ""
        Call un.atomicRMDir
        Pop $R0

        ${if} $R0 != 0
          DetailPrint "File is busy, aborting: $R0"

          Push ""
          Call un.restoreFiles
          Pop $R0

          Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
        ${endif}
      ${endif}

      RMDir /r $INSTDIR
    ${EndIf}
  !macroend

!else

  !insertmacro GEN_PURGE_LINKS ""

  ; Runs in .onInit, straight after initMultiUser has pointed $INSTDIR at any
  ; existing installation and BEFORE installSection.nsh invokes the PREVIOUS
  ; version's uninstaller. Purging here is what keeps an old, unsafe uninstaller
  ; from following links out of the install tree.
  !macro customInit
    StrCpy $purgedLinkCount 0
    ${If} ${FileExists} "$INSTDIR\*.*"
      Push "$INSTDIR"
      Call PurgeLinks
      ${If} $purgedLinkCount <> 0
      ${AndIfNot} ${Silent}
        MessageBox MB_OK|MB_ICONINFORMATION "Setup found $purgedLinkCount folder link(s) (junction or symbolic link) inside:$\r$\n$INSTDIR$\r$\n$\r$\nThe links have been removed so that installing or uninstalling cannot delete the folders they pointed to. The data they pointed at has NOT been touched.$\r$\n$\r$\nIf you created these links on purpose, please recreate them after Setup finishes."
      ${EndIf}
    ${EndIf}
  !macroend

!endif
