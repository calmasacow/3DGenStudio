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
run() {
  printf '\n$ %s\n' "$*"
  "$@" 2>&1
  printf '[exit %s]\n' "$?"
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
run codesign -d --entitlements - --verbose=2 "$APP"
run codesign --verify --deep --strict --verbose=2 "$APP"

section "Notarization"
run xcrun stapler validate "$APP"

section "Gatekeeper assessment"
# The verdict that produces the dialog the user sees.
run spctl --assess --type execute --verbose=4 "$APP"
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
  section "Direct launch (bypasses LaunchServices)"
  # Launching the binary straight from a shell shows the kernel-level reason.
  # "Killed: 9" here = AMFI rejected the signature (arm64 requires at least an
  # ad-hoc signature to execute); a normal Electron startup log = signature ok
  # and the refusal was purely Gatekeeper's.
  run "$APP/Contents/MacOS/$EXEC" --version
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

section "Done"
echo "Log written to: $OUT"
echo "Send this file back for analysis."
