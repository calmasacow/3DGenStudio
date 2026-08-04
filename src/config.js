// Central place to resolve where the backend (server.js) lives.
//
// Set VITE_SERVER_ORIGIN at build/dev time to point the frontend at a backend
// on another computer or port, e.g.
//   VITE_SERVER_ORIGIN=http://192.168.1.50:3001
// An empty string ("") forces same-origin (relative) URLs.
//
// LEAVE IT UNSET FOR PRODUCTION BUILDS, including LAN servers. It is tempting
// to set it to the server's address, but the value is baked into dist/ at build
// time — the bundle then only works from that exact host/port and breaks the
// moment a reverse proxy, a different port or a hostname is put in front. The
// backend serves dist/ and the API together, so same-origin always works.
// (Deployment-side counterpart: PUBLIC_BASE_URL / X-Forwarded-* in server.js.)
//
// When unset, the default depends on the build:
//  - production build (vite build): same origin ("") — Express serves dist/ and
//    the API together, so relative /api and /assets URLs just work.
//  - dev (vite dev): the standalone local backend on :3001.
const rawOrigin = import.meta.env.VITE_SERVER_ORIGIN
const defaultOrigin = import.meta.env.PROD ? '' : 'http://localhost:3001'

export const SERVER_ORIGIN = (rawOrigin === undefined ? defaultOrigin : rawOrigin)
  .replace(/\/$/, '')

export const API_BASE = `${SERVER_ORIGIN}/api`

// Build a URL to a static asset served from the backend's /assets mount.
export function assetUrl(pathOrFilename) {
  return `${SERVER_ORIGIN}/assets/${encodeURI(pathOrFilename)}`
}

// Build a URL to a bundled resource served from the backend's /resources mount
// (e.g. the reference animation library: resources/animations, resources/animpreviews).
export function resourceUrl(pathOrFilename) {
  return `${SERVER_ORIGIN}/resources/${encodeURI(pathOrFilename)}`
}
