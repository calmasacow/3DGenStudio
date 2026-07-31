#!/bin/bash
#
# mac-diagnose.sh — collect everything needed to explain a macOS
# «"3D Gen Studio" is damaged and can't be opened» refusal.
#
# That message is Gatekeeper's verdict, not a corrupt file: it means the app is
# quarantined (downloaded from the internet) AND its code signature is missing,
# broken, or not notarized. This script prints the exact state of the bundle so
# the cause can be identified from the log alone, without a Mac at hand.
#
# On a user's machine:
#   bash mac-diagnose.sh                        # checks /Applications/3D Gen Studio.app
#   bash mac-diagnose.sh --dmg ~/Downloads/3DGenStudio-2.2.0-mac-arm64.dmg
#
# On a macOS CI runner, against a freshly packaged bundle:
#   bash tools/mac-diagnose.sh --app "release/mac-arm64/3D Gen Studio.app" \
#        --quarantine --out mac-diagnostics.txt
#
# --quarantine copies the bundle, stamps it with the same com.apple.quarantine
# attribute a browser download gets, and re-runs the assessment — that is what
# reproduces the user-visible error on a machine where the app was built
# locally (locally built apps are never quarantined, so they always pass).

set -u

APP="/Applications/3D Gen Studio.app"
DMG=""
OUT=""
QUARANTINE=0
TRY_LAUNCH=0

# Prints the comment header above (everything from line 2 to the first
# non-comment line), so the usage text can never drift from the docs.
usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="${2:-}"; shift 2 ;;
    --dmg) DMG="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --quarantine) QUARANTINE=1; shift ;;
    --try-launch) TRY_LAUNCH=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$OUT" ]; then
  if [ -d "$HOME/Desktop" ]; then
    OUT="$HOME/Desktop/3dgenstudio-mac-diagnostics.txt"
  else
    OUT="/tmp/3dgenstudio-mac-diagnostics.txt"
  fi
fi

# Everything below is written to both the terminal and the log file.
exec > >(tee "$OUT") 2>&1

section() { printf '\n\n===== %s =====\n' "$1"; }

# Echo the command, run it, then record its exit status — a non-zero status is
# itself a finding (e.g. `codesign --verify` failing = broken signature).
# The status is also left in $LAST_STATUS for the verdict at the end.
LAST_STATUS=0
run() {
  printf '\n$ %s\n' "$*"
  "$@" 2>&1
  LAST_STATUS=$?
  printf '[exit %s]\n' "$LAST_STATUS"
  return 0
}

# Same, but kills the command if it outlasts $1 seconds, so a command that
# blocks can never wedge a CI job. Sets LAST_STATUS to 124 on timeout (matching
# GNU timeout) — macOS has no `timeout` binary of its own.
run_bounded() {
  secs="$1"; shift
  printf '\n$ %s   (bounded to %ss)\n' "$*" "$secs"
  bounded_out="$(mktemp)"
  "$@" >"$bounded_out" 2>&1 &
  bounded_pid=$!
  waited=0
  while kill -0 "$bounded_pid" 2>/dev/null && [ "$waited" -lt "$secs" ]; do
    sleep 1
    waited=$((waited + 1))
  done
  if kill -0 "$bounded_pid" 2>/dev/null; then
    kill -TERM "$bounded_pid" 2>/dev/null
    sleep 1
    kill -KILL "$bounded_pid" 2>/dev/null
    LAST_STATUS=124
  else
    wait "$bounded_pid"
    LAST_STATUS=$?
  fi
  cat "$bounded_out"
  rm -f "$bounded_out"
  printf '[exit %s]\n' "$LAST_STATUS"
  return 0
}

section "Report"
echo "app : $APP"
echo "dmg : ${DMG:-<not provided>}"
echo "log : $OUT"
echo "date: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"

section "Machine"
run sw_vers
run uname -m
run arch
system_profiler SPHardwareDataType 2>/dev/null | grep -E 'Model Name|Model Identifier|Chip|Processor' || true

if [ -n "$DMG" ]; then
  section "Download (.dmg / .zip)"
  run ls -l "$DMG"
  # A truncated or interrupted download is the one case where "damaged" really
  # does mean damaged — compare this hash with the one from the release.
  run shasum -a 256 "$DMG"
  run xattr -l "$DMG"
  case "$DMG" in
    *.dmg)
      run hdiutil verify "$DMG"
      run codesign -dv --verbose=4 "$DMG"
      run spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG"
      ;;
  esac
fi

if [ ! -d "$APP" ]; then
  section "Result"
  echo "App bundle not found at: $APP"
  echo "Pass the real location with --app '/path/to/3D Gen Studio.app'."
  echo
  echo "Log written to: $OUT"
  exit 1
fi

section "Bundle"
run ls -l "$APP/Contents"
run du -sh "$APP"
EXEC="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist" 2>/dev/null)"
echo "CFBundleExecutable: ${EXEC:-<unreadable Info.plist>}"
if [ -n "${EXEC:-}" ] && [ -f "$APP/Contents/MacOS/$EXEC" ]; then
  # Wrong slice = the app cannot run on this Mac at all (though that normally
  # reports "not supported on this Mac", not "damaged").
  run lipo -archs "$APP/Contents/MacOS/$EXEC"
  run file "$APP/Contents/MacOS/$EXEC"
fi

section "Quarantine attribute"
# Present => the app came from a browser/download and Gatekeeper will assess it.
# Absent  => Gatekeeper is not involved and "damaged" must come from elsewhere.
run xattr -l "$APP"
echo
echo "-- nested files carrying com.apple.quarantine (first 20) --"
xattr -r -l "$APP" 2>/dev/null | grep -c 'com.apple.quarantine' | sed 's/^/count: /'
xattr -r -l "$APP" 2>/dev/null | grep 'com.apple.quarantine' | head -20

section "Code signature"
# "code object is not signed at all"      => unsigned build (expected cause)
# "Authority=Developer ID Application..." => properly signed
# "Signature=adhoc"                       => ad-hoc signed, runs but not notarized
run codesign -dv --verbose=4 "$APP"
SIG_INFO="$(codesign -dv --verbose=4 "$APP" 2>&1)"
run codesign -d --entitlements - --verbose=2 "$APP"
run codesign --verify --deep --strict --verbose=2 "$APP"
VERIFY_STATUS=$LAST_STATUS

section "Notarization"
run xcrun stapler validate "$APP"
STAPLE_STATUS=$LAST_STATUS

section "Gatekeeper assessment"
# The verdict that produces the dialog the user sees.
run spctl --assess --type execute --verbose=4 "$APP"
SPCTL_STATUS=$LAST_STATUS
if command -v syspolicy_check >/dev/null 2>&1; then
  # macOS 14+: the same check Xcode's "distribution" validation runs.
  run syspolicy_check distribution "$APP"
fi

if [ "$QUARANTINE" -eq 1 ]; then
  section "Gatekeeper assessment WITH a simulated download quarantine"
  TMP="$(mktemp -d)"
  COPY="$TMP/$(basename "$APP")"
  # ditto (not cp) preserves symlinks, hard links and xattrs inside the bundle.
  run ditto "$APP" "$COPY"
  # 0081 = "quarantined, never assessed" — what Safari/Chrome stamp on a
  # download. The trailing fields are flags;timestamp;agent;event-id.
  run xattr -w -r com.apple.quarantine "0081;00000000;Safari;" "$COPY"
  run xattr -l "$COPY"
  run codesign --verify --deep --strict --verbose=2 "$COPY"
  run spctl --assess --type execute --verbose=4 "$COPY"
  rm -rf "$TMP"
fi

if [ "$TRY_LAUNCH" -eq 1 ] && [ -n "${EXEC:-}" ]; then
  section "Direct exec of the signed binary (bypasses LaunchServices)"
  # Answers "will the kernel even run this binary?", separately from what
  # Gatekeeper thinks: signal 9 / "Killed" here = AMFI rejected the signature
  # (an arm64 binary needs at least a valid ad-hoc signature to exec at all),
  # while a clean exit 0 means the signature is accepted and any refusal to
  # open the app is purely Gatekeeper's.
  #
  # ELECTRON_RUN_AS_NODE runs the very same Mach-O — so the same signature
  # check — as plain Node, and `process.exit(0)` returns immediately. Do NOT
  # launch the app normally here: it boots the backend and the GUI and never
  # returns, which wedged a CI job for 81 minutes before this was fixed.
  # Bounded as well, in case the exec itself hangs.
  SLICES="$(lipo -archs "$APP/Contents/MacOS/$EXEC" 2>/dev/null)"
  echo "binary arch: ${SLICES:-unknown} | this machine: $(uname -m)"
  export ELECTRON_RUN_AS_NODE=1
  run_bounded 30 "$APP/Contents/MacOS/$EXEC" -e 'process.exit(0)'
  unset ELECTRON_RUN_AS_NODE
  case "$LAST_STATUS" in
    0) echo "=> binary exec'd fine: the code signature is accepted by the kernel" ;;
    124) echo "=> timed out (unexpected for -e process.exit(0)); inconclusive" ;;
    126) echo "=> could not exec — with an arch mismatch above this is 'Bad CPU type'" \
              "(no Rosetta), which says nothing about the signature" ;;
    137|139) echo "=> KILLED: the kernel rejected the signature — this is the 'damaged' cause" ;;
    *) echo "=> exited $LAST_STATUS: exec was allowed (a non-zero status here is a Node error, not a signature problem)" ;;
  esac
fi

section "System policy log (last 30 min)"
log show --predicate 'subsystem == "com.apple.syspolicy"' --last 30m --style compact 2>/dev/null | tail -80 || \
  echo "(log show unavailable)"

section "App's own logs (only exist if it ever launched)"
for dir in "$HOME/Library/Application Support/3DGenStudio/logs" \
           "$HOME/Library/Application Support/3D Gen Studio/logs" \
           "$HOME/Library/Logs/3DGenStudio"; do
  if [ -d "$dir" ]; then
    echo "-- $dir --"
    ls -l "$dir"
    for f in "$dir"/*.log; do
      [ -f "$f" ] || continue
      echo
      echo "---- tail -50 $f ----"
      tail -50 "$f"
    done
  fi
done

section "Recent crash reports"
ls -lt "$HOME/Library/Logs/DiagnosticReports" 2>/dev/null | head -15 || echo "(none)"

section "Verdict"
# Reads the collected evidence back and states what a user downloading this
# build will actually see. The distinction that matters: a *valid* signature
# (even ad-hoc) produces the bypassable "Apple could not verify…" warning,
# while a missing or broken one produces the dead-end "is damaged" refusal.
# `spctl: rejected` alone does not tell the two apart — it rejects anything
# that is not notarized.
case "$SIG_INFO" in
  *"not signed at all"*) SIG_KIND="unsigned" ;;
  *"Authority=Developer ID Application"*) SIG_KIND="developer-id" ;;
  *"Signature=adhoc"*) SIG_KIND="adhoc" ;;
  *) SIG_KIND="unknown" ;;
esac

echo "signature      : $SIG_KIND"
echo "signature seal : $([ "$VERIFY_STATUS" -eq 0 ] && echo 'valid (contents match)' || echo "BROKEN (codesign --verify exit $VERIFY_STATUS)")"
echo "notarized      : $([ "$STAPLE_STATUS" -eq 0 ] && echo yes || echo 'no ticket stapled')"
echo "spctl          : $([ "$SPCTL_STATUS" -eq 0 ] && echo accepted || echo rejected)"
echo
if [ "$SIG_KIND" = "developer-id" ] && [ "$STAPLE_STATUS" -eq 0 ] && [ "$VERIFY_STATUS" -eq 0 ]; then
  echo "=> Signed and notarized: installs with no warning."
elif [ "$SIG_KIND" = "unsigned" ] || [ "$VERIFY_STATUS" -ne 0 ]; then
  echo "=> Expect: \"is damaged and can't be opened\" — a dead end for the user."
  echo "   Cause: the signature is missing or does not match the bundle contents."
  echo "   Fix: build/adhoc-sign.cjs should have ad-hoc signed this bundle; check"
  echo "   the packaging log for 'ad-hoc signing FAILED'."
else
  echo "=> Expect: \"Apple could not verify … is free of malware\" — bypassable via"
  echo "   System Settings → Privacy & Security → Open Anyway. NOT the \"damaged\""
  echo "   dead end. Removing it entirely requires a Developer ID + notarization."
fi

section "Done"
echo "Log written to: $OUT"
echo "Send this file back for analysis (start at the Verdict section)."
