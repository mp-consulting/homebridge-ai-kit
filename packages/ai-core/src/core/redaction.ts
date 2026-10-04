/**
 * Keeps plugin credentials in config.json out of the model's context.
 *
 * `redactSecrets` swaps secret-looking values for a placeholder before the
 * config is shown; `restoreSecrets` puts the real values back when the model
 * writes the config, so a read → edit → write round trip is lossless.
 */

export const REDACTED = '__REDACTED__';

/** Keys whose values are treated as secrets, e.g. password, mqttPass, apiKey, clientSecret, bridge.pin. */
const SECRET_KEY = /pass(word|wd|phrase)?$|secret|token|api[-_]?key|private[-_]?key|credential|^pin$/i;

/** Keys that look secret but hold token counts, e.g. `maxOutputTokens` or `contextTokens`. */
const NOT_SECRET_KEY = /(max|min|context|input|output|total)\w*tokens$/i;

/** Whether the value under `key` is treated as a secret. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key) && !NOT_SECRET_KEY.test(key);
}

/** Fields that identify an entry in an array such as `platforms` or `accessories`. */
const IDENTITY_KEYS = ['platform', 'accessory', 'name', 'id', 'username'] as const;

type Json = unknown;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isSecretValue(v: unknown): boolean {
  return (typeof v === 'string' && v !== '') || typeof v === 'number';
}

/** Deep copy of `value` with every secret replaced by {@link REDACTED}. */
export function redactSecrets(value: Json, underSecretKey = false): Json {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, underSecretKey));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, redactSecrets(v, underSecretKey || isSecretKey(key))]),
    );
  }
  return underSecretKey && isSecretValue(value) ? REDACTED : value;
}

export function containsRedacted(value: Json): boolean {
  return JSON.stringify(value).includes(JSON.stringify(REDACTED));
}

export class SecretRestoreError extends Error {
  constructor(readonly paths: string[]) {
    super(
      `Cannot restore ${REDACTED} at ${paths.join(', ')}: no matching value in the current config. ` +
        'Supply the real value, or keep the entry\'s identifying fields (platform, accessory, name) unchanged.',
    );
  }
}

function identity(item: unknown, index: number): string {
  if (isPlainObject(item)) {
    const parts = IDENTITY_KEYS.filter((k) => typeof item[k] === 'string' || typeof item[k] === 'number').map(
      (k) => `${k}=${item[k]}`,
    );
    if (parts.length > 0) {
      return parts.join('&');
    }
  }
  return `#${index}`;
}

/**
 * The entry of `current` that corresponds to `item`: matched by identity
 * fields when it has any, by position otherwise. Ambiguous matches return
 * undefined so a reordered list can never receive another entry's secret.
 */
function counterpart(item: unknown, index: number, current: unknown[]): unknown {
  const id = identity(item, index);
  if (id.startsWith('#')) {
    return current[index];
  }
  const found = current.filter((c, j) => identity(c, j) === id);
  return found.length === 1 ? found[0] : undefined;
}

/**
 * Replace every {@link REDACTED} in `next` with the real value from `current`.
 * @throws SecretRestoreError listing each placeholder that has no counterpart.
 */
export function restoreSecrets(next: Json, current: Json): Json {
  const missing: string[] = [];

  const walk = (n: unknown, c: unknown, path: string): unknown => {
    if (n === REDACTED) {
      if (isSecretValue(c)) {
        return c;
      }
      missing.push(path || '(root)');
      return n;
    }
    if (Array.isArray(n)) {
      const cur = Array.isArray(c) ? c : [];
      return n.map((item, i) => walk(item, counterpart(item, i, cur), `${path}[${i}]`));
    }
    if (isPlainObject(n)) {
      const cur = isPlainObject(c) ? c : {};
      return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, walk(v, cur[k], path ? `${path}.${k}` : k)]));
    }
    return n;
  };

  const restored = walk(next, current, '');
  if (missing.length > 0) {
    throw new SecretRestoreError(missing);
  }
  return restored;
}

/** `key: value`, `key=value` and `"key": "value"` pairs whose key names a secret. */
const SECRET_PAIR =
  /(["']?)([\w.-]*(?:password|passwd|passphrase|secret|token|api[-_]?key|private[-_]?key|credential)[\w-]*)\1(\s*[:=]\s*)(["']?)([^\s"',;}&]+)\4/gi;

/** Well-known credential shapes that can appear anywhere in free text. */
const SECRET_SHAPES: RegExp[] = [
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, // Authorization headers
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic style keys
  /\bhbg_[A-Za-z0-9_-]{8,}/g, // Homebridge Glass UI API tokens
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API keys
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWTs
];

/**
 * Best-effort redaction of free text such as log lines or error messages:
 * values of secret-named keys and well-known credential shapes become {@link REDACTED}.
 */
export function redactText(text: string): string {
  let out = text.replace(SECRET_PAIR, (m, q: string, key: string, sep: string, vq: string) =>
    NOT_SECRET_KEY.test(key) ? m : `${q}${key}${q}${sep}${vq}${REDACTED}${vq}`,
  );
  for (const shape of SECRET_SHAPES) {
    out = out.replace(shape, (m) => (/^(Bearer|Basic)\s/.test(m) ? `${m.split(/\s+/)[0]} ${REDACTED}` : REDACTED));
  }
  return out;
}
