# Desktop build resources

Non-icon files here:

- `adhoc-sign.cjs` — `afterPack` hook. Ad-hoc signs the macOS bundle when no
  Developer ID certificate is available, so macOS shows a bypassable warning
  instead of refusing the app as "damaged". No-op on Windows/Linux and when a
  real certificate is present. See `docs/DESKTOP_BUILD.md`.
- `entitlements.mac.plist` — hardened-runtime entitlements for the *signed*
  build (JIT + library validation off, needed for sqlite3 and the Python
  services).

electron-builder looks in this directory (`buildResources`) for platform icons.

Currently:
- **Windows** uses `public/3dgenstudio.ico` (configured in `electron-builder.yml`).
- **macOS** and **Linux** fall back to the default Electron icon.

To brand the macOS and Linux builds, add:

- `build/icon.icns` — macOS icon (1024×1024 source recommended).
- `build/icon.png` — Linux icon, **512×512** (electron-builder requires ≥256×256).

Then set `mac.icon: build/icon.icns` and `linux.icon: build/icon.png` in
`electron-builder.yml`. You can generate both from a single PNG with tools like
`electron-icon-builder` or `png2icns`.
