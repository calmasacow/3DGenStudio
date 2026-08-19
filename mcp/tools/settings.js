import { z } from 'zod';
import { toolHandler } from '../client.js';

const SECRET_KEY_PATTERN = /(api[-_]?key|secret|token|password|credential|authorization)/i;

// Recursively replace secret-looking string values so API keys configured in
// Settings never leave the machine through an MCP client.
function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY_PATTERN.test(key) && typeof item === 'string' && item.length > 0
        ? '***redacted***'
        : redactSecrets(item);
    }
    return out;
  }
  return value;
}

// The mirror of redactSecrets on the way in. Reads are redacted, so a client
// that round-trips a settings object would otherwise write the literal string
// "***redacted***" over a real key and lock the user out of their own provider.
// Refusing outright (rather than dropping the key silently) is the safer answer:
// a caller that meant to set a credential learns it did not happen.
function collectSecretPaths(value, trail = []) {
  const found = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...collectSecretPaths(item, [...trail, String(index)])));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const path = [...trail, key];
      if (SECRET_KEY_PATTERN.test(key)) found.push(path.join('.'));
      else found.push(...collectSecretPaths(item, path));
    }
  }
  return found;
}

export function registerSettingsTools(server, { api }) {
  server.registerTool('get_settings', {
    title: 'Get settings (redacted)',
    description: 'Read the app settings — which AI providers and custom APIs are configured (their ids for selectedApi), service URLs (ComfyUI, mesh tools, rigging), and preferences. All API keys and secrets are redacted.',
    annotations: { readOnlyHint: true }
  }, toolHandler(async () => redactSecrets(await api.apiJson('GET', '/settings'))));

  server.registerTool('update_settings', {
    title: 'Update settings',
    description: 'Update app settings. The object is DEEP-MERGED into the current settings, so pass only the keys you want to change — e.g. {"comfyui": {"url": "http://127.0.0.1:8188"}} or {"apis": {"meshtools": {"url": "http://127.0.0.1:8200"}}}. Call get_settings first to see the exact shape. Credentials CANNOT be written through MCP: any key that looks like an api key, secret, token, password, or credential is refused, because reads are redacted and a round trip would otherwise overwrite a real key with the redaction placeholder. Set those in the app\'s Settings dialog instead. Returns the merged settings, redacted.',
    inputSchema: {
      settings: z.record(z.string(), z.any()).describe('Partial settings object, deep-merged into the current settings.')
    }
  }, toolHandler(async ({ settings }) => {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('settings must be an object.');
    }
    const secrets = collectSecretPaths(settings);
    if (secrets.length) {
      throw new Error(
        `Refusing to write credential fields over MCP: ${secrets.join(', ')}. `
        + 'Set API keys and secrets in the app\'s Settings dialog — reads are redacted here, so writing them back would destroy the stored values.'
      );
    }
    if (!Object.keys(settings).length) {
      throw new Error('Provide at least one setting to change.');
    }
    return redactSecrets(await api.apiJson('POST', '/settings', { body: settings }));
  }));

  server.registerTool('get_system_stats', {
    title: 'Get system stats',
    description: 'Live CPU, RAM, and GPU usage of the machine running 3D Gen Studio.',
    annotations: { readOnlyHint: true }
  }, toolHandler(async () => api.apiJson('GET', '/system/stats')));
}
