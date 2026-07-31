; Custom NSIS logic for the 3D Gen Studio Windows installer/uninstaller.
;
; WHY THIS FILE EXISTS
; -------------------
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
