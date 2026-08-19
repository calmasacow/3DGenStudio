#!/usr/bin/env node
// stdio entry point for MCP clients that spawn a process (e.g. Claude Desktop
// local servers). It is a thin bridge: tools still call the RUNNING 3D Gen
// Studio backend over loopback HTTP — this process never opens the database.
//
// Usage: node mcp/stdio.js        (app must be running, default :3001)
//        GENSTUDIO_URL=http://localhost:3001 node mcp/stdio.js
//        node mcp/stdio.js --tools=projects,graph,assets   (load only those groups)
//        node mcp/stdio.js --tools=-mesh                   (load everything except mesh)
//
// The full catalog costs a client ~25k tokens of system prompt per session, so
// --tools / MCP_TOOLS lets a small-context model load only what it needs. The
// flag exists as well as the env var because clients differ in whether they
// pass `env` through to the spawned process — every client passes `args`.
import process from 'node:process';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer } from './index.js';

const baseUrl = (process.env.GENSTUDIO_URL || `http://127.0.0.1:${process.env.PORT || 3001}`).replace(/\/+$/, '');

// --tools=a,b  |  --tools a,b  |  fall back to MCP_TOOLS, then every group.
function readToolsFlag(argv) {
  const index = argv.findIndex(arg => arg === '--tools' || arg.startsWith('--tools='));
  if (index === -1) return undefined;
  const arg = argv[index];
  return arg.startsWith('--tools=') ? arg.slice('--tools='.length) : argv[index + 1];
}

const groups = readToolsFlag(process.argv.slice(2)) ?? process.env.MCP_TOOLS;

try {
  const res = await fetch(`${baseUrl}/api/projects`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (err) {
  console.error(`3D Gen Studio is not reachable at ${baseUrl} (${err?.message || err}).`);
  console.error('Start the app first (npm run dev, or launch the desktop app), then retry.');
  process.exit(1);
}

const server = buildMcpServer({ baseUrl, groups });
await server.connect(new StdioServerTransport());
