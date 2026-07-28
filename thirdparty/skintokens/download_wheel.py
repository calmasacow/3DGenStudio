"""Download a wheel URL to a local file and print its path (for run_server.bat).

Installing flash-attn straight from its URL with ``pip install <url>`` fails on
Hugging Face Xet-backed files (the redirect to the Xet CAS bridge returns HTTP
403 to pip). Fetching through the ``huggingface_hub`` client instead (which uses
the ``hf_xet`` integration) downloads them correctly. Plain URLs (e.g. GitHub
release assets) are fetched with urllib.

Usage:
    python download_wheel.py <url>

Prints the local file path on success (stdout), diagnostics on stderr, and
exits non-zero on failure so the caller can skip the install.
"""
from __future__ import annotations

import os
import re
import shutil
import sys
import tempfile
import urllib.parse
import urllib.request


def download(url: str) -> str:
    if "huggingface.co" in url:
        # https://huggingface.co/<owner>/<repo>/resolve/<rev>/<path-to-file>[?...]
        m = re.search(r"huggingface\.co/([^/]+/[^/]+)/resolve/[^/]+/(.+)$", url)
        if not m:
            raise ValueError(f"Could not parse a HF repo/filename from: {url}")
        repo_id = m.group(1)
        # URL-decode the filename: the URL may contain %2B for '+' (as in
        # flash_attn-2.8.3%2Bd2026...). hf_hub_download re-encodes the filename to
        # build the request, so passing the still-encoded form would double-encode
        # it (%2B -> %252B) and 404. Decoding first ('+') lets it re-encode
        # correctly. unquote leaves a literal '+' untouched, so both forms work.
        filename = urllib.parse.unquote(m.group(2).split("?")[0])
        from huggingface_hub import hf_hub_download

        # Returns a path inside the HF cache; pip installs it fine.
        return hf_hub_download(repo_id=repo_id, filename=filename)

    # Plain HTTP(S) download (e.g. GitHub release assets).
    #
    # The original basename MUST be preserved. pip/uv read the distribution name,
    # version and compatibility tags out of the wheel FILENAME, so a mkstemp name
    # like "flash_attn_t5eu90p9.whl" is rejected before the file is even opened:
    #   error: The wheel filename "flash_attn_t5eu90p9.whl" is invalid: Must have a version
    # So download into a temp DIRECTORY and keep the name the server gave us.
    name = os.path.basename(urllib.parse.unquote(urllib.parse.urlparse(url).path))
    if not name.endswith(".whl"):
        raise ValueError(f"URL does not name a .whl file: {url}")
    path = os.path.join(tempfile.mkdtemp(prefix="flash_attn_"), name)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    # copyfileobj streams: these wheels are a few hundred MB and don't need to be
    # held in memory in one piece.
    with urllib.request.urlopen(req) as resp, open(path, "wb") as out:
        shutil.copyfileobj(resp, out)
    return path


def main() -> None:
    if len(sys.argv) < 2 or not sys.argv[1].strip():
        print("[download_wheel] usage: python download_wheel.py <url>", file=sys.stderr)
        sys.exit(2)
    try:
        print(download(sys.argv[1].strip()))
    except Exception as exc:  # noqa: BLE001 — the caller only needs pass/fail
        print(f"[download_wheel] failed: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
