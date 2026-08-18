// Read-only access to the service log files, so users can see what the backend,
// the Python services and ComfyUI are doing without digging through the file
// system.
//
// The desktop shell (electron/main.cjs) is what actually WRITES these files: it
// pipes each spawned process's stdout/stderr into `<userData>/logs/<name>.log`
// and — unless the user turns off "Clear the logs at startup" in the Logs panel
// — rotates them all at startup, so one file == one session. This module
// only reads them, which is why it is safe to expose over the normal API.
//
// Reads are incremental and bounded: the client passes back the `nextOffset` it
// last received and gets only the bytes appended since. That keeps a 200 MB
// ComfyUI log from ever being loaded into a browser tab, and makes "follow"
// mode a cheap poll instead of a full re-read.
import path from 'node:path';
import fsp from 'node:fs/promises';
import process from 'node:process';
import { Buffer } from 'node:buffer';

// Never hand back more than this in one response. Applies to the first read
// (which starts at `size - MAX_CHUNK_BYTES`) and clamps a client that has been
// away long enough for the file to have grown past it.
const MAX_CHUNK_BYTES = 512 * 1024;

// id -> file name + how to describe it in the UI. The ids are a closed set, so
// no request can ever reach a path outside the log directory.
export const LOG_SOURCES = [
  {
    id: 'desktop',
    file: 'desktop.log',
    label: '3D Gen Studio',
    description: 'Desktop shell: startup, service supervision, setup and updates.',
    desktopOnly: true,
  },
  {
    id: 'backend',
    file: 'backend.log',
    label: 'Backend',
    description: 'Node API server (server.js): projects, assets, workflow runs.',
    desktopOnly: true,
  },
  {
    id: 'meshtools',
    file: 'python.log',
    label: 'Mesh Service',
    description: 'Python mesh tools: Auto UV, retopology, repair, LOD, bake.',
    desktopOnly: true,
  },
  {
    id: 'rigging',
    file: 'rig.log',
    label: 'SkinTokens Service',
    description: 'Python rigging service: Auto Rig and animation retargeting.',
    desktopOnly: true,
  },
  {
    id: 'comfyui',
    file: 'comfyui.log',
    label: 'ComfyUI',
    description: 'Managed ComfyUI install. An external ComfyUI logs to its own console instead.',
    desktopOnly: true,
  },
];

const SOURCES_BY_ID = new Map(LOG_SOURCES.map((s) => [s.id, s]));

// Where the log files live. The desktop shell passes GENSTUDIO_LOG_DIR when it
// spawns the backend; a bare `node server.js` falls back to ./logs, which
// normally does not exist — the UI then simply shows every source as empty.
export function resolveLogDir() {
  const fromEnv = String(process.env.GENSTUDIO_LOG_DIR || '').trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(process.cwd(), 'logs');
}

// Terminal control codes are noise in an HTML <pre>. Strip the colour/cursor
// escapes, then collapse in-place progress redraws ("\r" without "\n", which is
// how ComfyUI, pip and uv animate progress bars) down to the final state of
// each line — otherwise a single download renders as hundreds of near-identical
// lines.
// 27 = ESC. Built with fromCharCode so no raw control byte ends up in this
// source file, where an editor or a copy-paste would silently mangle it.
const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(ESC + String.raw`\[[0-9;?]*[ -\/]*[@-~]`, 'g');

function normalizeLogText(raw) {
  return raw
    .replace(ANSI_PATTERN, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.includes('\r') ? line.slice(line.lastIndexOf('\r') + 1) : line))
    .join('\n');
}

async function statLog(file) {
  try {
    const stat = await fsp.stat(file);
    return { exists: stat.isFile(), size: stat.size, modifiedAt: stat.mtime.toISOString() };
  } catch {
    return { exists: false, size: 0, modifiedAt: null };
  }
}

/**
 * Read the bytes appended to `file` since byte offset `since`.
 *
 * `since === null` means "give me the tail" (first open). The read is clamped to
 * MAX_CHUNK_BYTES and always resumes on a line boundary, so `nextOffset` can be
 * fed straight back in without ever splitting a UTF-8 sequence.
 *
 * Returns `{ text, pending, ... }`: `text` is whole lines the client APPENDS,
 * `pending` is the trailing incomplete line it REPLACES each poll (a service
 * that is mid-write, or a progress bar that has not terminated its line yet).
 */
async function readLogSlice(file, since) {
  const { exists, size, modifiedAt } = await statLog(file);
  if (!exists) {
    return { exists: false, size: 0, modifiedAt: null, from: 0, nextOffset: 0, reset: true, text: '', pending: '' };
  }

  // `since > size` means the file shrank under us — which is what a client sees
  // when the app is relaunched (with startup clearing on) while the panel is
  // open. Treat it as a fresh file.
  let reset = since === null || since === undefined || since > size || since < 0;
  let from = reset ? Math.max(0, size - MAX_CHUNK_BYTES) : since;
  if (size - from > MAX_CHUNK_BYTES) {
    from = size - MAX_CHUNK_BYTES;
    reset = true;
  }

  let buf = Buffer.alloc(0);
  if (size > from) {
    const handle = await fsp.open(file, 'r');
    try {
      buf = Buffer.alloc(size - from);
      const { bytesRead } = await handle.read(buf, 0, buf.length, from);
      if (bytesRead < buf.length) buf = buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  // A tail that starts mid-file almost certainly starts mid-line; drop that
  // fragment rather than show a decapitated first entry.
  if (reset && from > 0) {
    const firstNewline = buf.indexOf(0x0a);
    if (firstNewline === -1) {
      from += buf.length;
      buf = Buffer.alloc(0);
    } else {
      from += firstNewline + 1;
      buf = buf.subarray(firstNewline + 1);
    }
  }

  // Only commit up to the last complete line. Anything after it is handed over
  // as `pending` and re-sent (completed) on the next poll.
  const lastNewline = buf.lastIndexOf(0x0a);
  const complete = lastNewline === -1 ? Buffer.alloc(0) : buf.subarray(0, lastNewline + 1);
  const partial = lastNewline === -1 ? buf : buf.subarray(lastNewline + 1);

  return {
    exists: true,
    size,
    modifiedAt,
    from,
    nextOffset: from + complete.length,
    reset,
    text: normalizeLogText(complete.toString('utf8')),
    pending: normalizeLogText(partial.toString('utf8')),
  };
}

export function mountLogs(app, { logDir = resolveLogDir() } = {}) {
  // Catalogue + freshness, cheap enough to poll: drives the source list and its
  // "empty / N KB" hints without transferring any log content.
  app.get('/api/logs', async (_req, res) => {
    try {
      const sources = await Promise.all(LOG_SOURCES.map(async (source) => {
        const { exists, size, modifiedAt } = await statLog(path.join(logDir, source.file));
        return { ...source, exists, size, modifiedAt };
      }));
      res.json({ dir: logDir, sources });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Incremental tail. `?since=<byteOffset>` continues a previous read; omit it
  // (or pass nothing) to get the last chunk of the file.
  app.get('/api/logs/:id', async (req, res) => {
    const source = SOURCES_BY_ID.get(req.params.id);
    if (!source) return res.status(404).json({ error: `Unknown log '${req.params.id}'` });

    const rawSince = req.query.since;
    const parsedSince = rawSince === undefined || rawSince === '' ? null : Number(rawSince);
    if (parsedSince !== null && !Number.isFinite(parsedSince)) {
      return res.status(400).json({ error: '`since` must be a byte offset' });
    }

    try {
      const slice = await readLogSlice(path.join(logDir, source.file), parsedSince);
      res.json({ id: source.id, label: source.label, file: source.file, ...slice });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}
