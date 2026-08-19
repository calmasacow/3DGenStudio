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
; WHY ONLY "INSTALL FOR ME" HITS THIS
; -----------------------------------
; Reported from the field: the dialog appears for a per-user install but never
; for an all-users one. That is not a difference in detection - the all-users
; path never checks at all. With perMachine: false, picking "anyone who uses
; this computer" makes the installer relaunch itself elevated, and the install
; section then runs in that inner instance, where the vendor guards the call:
;
;   ${ifNot} ${UAC_IsInnerInstance}     ; installSection.nsh
;     !insertmacro CHECK_APP_RUNNING
;   ${endif}
;
; A per-user install needs no elevation, so it IS the outer instance and the
; check runs. Worth knowing before chasing a per-user-only detection bug that
; does not exist - and worth remembering that an all-users install therefore
; happily writes over a running app.
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
    Push $R4   ; diagnostic log path
    Push $R5   ; diagnostic file handle

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
        ; Capture evidence before prompting. The log separates the two causes we
        ; cannot tell apart from here: a process we are not allowed to kill
        ; (taskkill says "Access is denied" - elevated, or the USERNAME filter not
        ; matching) versus one wedged in the kernel (taskkill reports SUCCESS and
        ; the process is STILL listed afterwards - only a reboot clears that).
        ; The second taskkill drops the USERNAME filter on purpose: if only that
        ; one works, the filter is the problem.
        ;
        ; Deliberately no PowerShell and no nested quoting - both were tried and
        ; came back empty, and a diagnostic that only works sometimes is worse
        ; than none. What Setup already knows is written by NSIS itself.
        StrCpy $R4 "$TEMP\3DGenStudio-setup-appcheck.log"
        FileOpen $R5 "$R4" w
        FileWrite $R5 "== setup ==$\r$\n"
        FileWrite $R5 "installing to : $INSTDIR$\r$\n"
        ReadRegStr $R3 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
        FileWrite $R5 "per-user copy : $R3$\r$\n"
        ReadRegStr $R3 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
        FileWrite $R5 "all-users copy: $R3$\r$\n"
        FileClose $R5
        nsExec::Exec `"$SYSDIR\cmd.exe" /c (echo == tasklist == & tasklist /v /fi "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" & echo == taskkill, as Setup runs it == & taskkill /f /im "${APP_EXECUTABLE_FILENAME}" /fi "PID ne $R2" /fi "USERNAME eq %USERNAME%" & echo == taskkill, no user filter == & taskkill /f /im "${APP_EXECUTABLE_FILENAME}" /fi "PID ne $R2" & echo == still there? == & tasklist /fi "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}") >> "$R4" 2>&1`
        Pop $R3
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
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "${PRODUCT_NAME} could not be closed automatically.$\r$\n$\r$\nA process named $\"${APP_EXECUTABLE_FILENAME}$\" is still running. It may have no window, so it will not appear under Apps in the Task Manager: look for ${PRODUCT_NAME} under Background processes and end it there, or open a Command Prompt and run$\r$\n$\r$\n    taskkill /f /im $\"${APP_EXECUTABLE_FILENAME}$\"$\r$\n$\r$\nThen click Retry. If it still cannot be closed, restarting Windows always clears it.$\r$\n$\r$\nDetails for support were written to:$\r$\n$R4" /SD IDCANCEL IDRETRY +2
          Quit
        StrCpy $R1 3              ; Retry: straight back to the force-kill pass
      stuckHandled:
      ${EndIf}
    ${Loop}

    ; The processes are gone, but Windows releases their file handles slightly
    ; later, and uninstallOldVersion runs immediately after this macro. If it
    ; meets a file it cannot rename it aborts, and its own retry loop ends in
    ; "$(appCannotBeClosed)" - the message users see for an app they did close.
    ; Waiting for the OLD executable to become writable costs nothing when the
    ; tree is already free (one FileOpen) and removes the race when it is not.
    ;
    ; This only probes the executable. A leftover Python service can hold the
    ; tree too - electron/pysetup.cjs starts them with cwd inside the install
    ; directory (python-server, thirdparty/skintokens) and they are named
    ; python.exe, so nothing here can see them. That is what the busy-file log
    ; written by customRemoveFiles is for.
    ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      StrCpy $R1 0
      ${Do}
        ClearErrors
        FileOpen $R3 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" a
        ${IfNot} ${Errors}
        ${AndIf} $R3 != ""
          FileClose $R3            ; writable => nothing has it mapped any more
          ${ExitDo}
        ${EndIf}
        IntOp $R1 $R1 + 1
        ${If} $R1 >= 20            ; ~10 s, then let the uninstaller have its go
          DetailPrint "Previous installation is still in use - continuing anyway."
          ${ExitDo}
        ${EndIf}
        DetailPrint "Waiting for the previous installation to be released..."
        Sleep 500
      ${Loop}
    ${EndIf}

    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
  ${EndIf}
!macroend

!ifdef BUILD_UNINSTALLER

  !insertmacro GEN_PURGE_LINKS "un."

  ; Appends one "which file was busy" line to the same log the installer's
  ; app-running check writes. Without it a slow update is indistinguishable from
  ; a stuck one, and nobody can tell WHAT was holding the file.
  !macro LOG_BUSY_FILE _ATTEMPT _PATH _HANDLE
    FileOpen ${_HANDLE} "$TEMP\3DGenStudio-setup-appcheck.log" a
    ${If} ${_HANDLE} == ""
      FileOpen ${_HANDLE} "$TEMP\3DGenStudio-setup-appcheck.log" w
    ${EndIf}
    ${If} ${_HANDLE} != ""
      FileSeek ${_HANDLE} 0 END
      FileWrite ${_HANDLE} "uninstall: busy file (attempt ${_ATTEMPT}): ${_PATH}$\r$\n"
      FileClose ${_HANDLE}
    ${EndIf}
  !macroend

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

      ; UPDATE PATH: rename the old tree aside first, so a failure can roll back.
      ;
      ; The vendor gives up the moment un.atomicRMDir reports a busy file, and
      ; installUtil.nsh's uninstallOldVersion then re-runs this whole uninstaller
      ; five times before showing "$(appCannotBeClosed)" - a message about the
      ; APP being open, for what is really one file still held open. That is why
      ; clicking Retry works: by then the handle is gone - which is exactly what
      ; was reported from the field, on an app that was genuinely closed.
      ;
      ; Waiting here instead makes it invisible. Candidates for the holder, none
      ; of which the app-running check can see: the app's own service teardown
      ; (main.cjs kills the Python services with taskkill /T /F, which outlives
      ; the app process), an AV scan of the ~190 MB executable, or the shell's
      ; icon cache. The busy path is recorded either way.
      ${if} ${isUpdated}
        CreateDirectory "$PLUGINSDIR\old-install"

        StrCpy $R1 0
        ${Do}
          Push ""
          Call un.atomicRMDir
          Pop $R0
          ${If} $R0 == 0
            ${ExitDo}                 ; whole tree renamed aside
          ${EndIf}

          DetailPrint "File is busy, waiting: $R0"
          !insertmacro LOG_BUSY_FILE $R1 $R0 $R3

          ; atomicRMDir has already moved part of the tree; put it back before
          ; trying again, or the next attempt starts from a half-moved install.
          Push ""
          Call un.restoreFiles
          Pop $R2

          IntOp $R1 $R1 + 1
          ${If} $R1 >= 20            ; ~10 s of waiting, plus each attempt's own
            Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install" - $R0 is still in use.`
          ${EndIf}
          Sleep 500
        ${Loop}
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
