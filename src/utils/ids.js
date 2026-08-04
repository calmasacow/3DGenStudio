const HEX = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, '0'))

function randomBytes(length) {
  const bytes = new Uint8Array(length)

  // getRandomValues is available in insecure contexts; randomUUID is not.
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
    return bytes
  }

  for (let index = 0; index < length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256)
  }

  return bytes
}

/**
 * RFC 4122 version 4 UUID.
 *
 * crypto.randomUUID only exists in a secure context (HTTPS or localhost), so serving the app over
 * plain HTTP on a LAN IP leaves it undefined. Anything ComfyUI sees as prompt_id / client_id must
 * still be a real UUID, so the fallback builds one instead of an ad-hoc string.
 */
export function createUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  const bytes = randomBytes(16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = Array.from(bytes, byte => HEX[byte]).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value) {
  return UUID_PATTERN.test(String(value || '').trim())
}

/**
 * Identifier for a ComfyUI execution (prompt_id / client_id). ComfyUI validates both as UUIDs, so
 * the prefix is accepted for call-site readability only and never reaches the wire.
 */
export function createComfyExecutionId() {
  return createUuid()
}
