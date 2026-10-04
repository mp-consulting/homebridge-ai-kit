/**
 * What an MCP client token may do. Each scope includes the ones before it:
 * - `read` — read-only tools
 * - `control` — plus everyday device control (`set_accessory`, `set_security_accessory`)
 * - `admin` — plus everything else: config, plugins, restarts, cached accessories, child bridges
 */
export const SCOPES = ['read', 'control', 'admin'] as const;
export type Scope = (typeof SCOPES)[number];

export function isScope(value: unknown): value is Scope {
  return (SCOPES as readonly unknown[]).includes(value);
}

/** Whether a token with `granted` may use a tool that needs `required`. */
export function scopeAllows(granted: Scope, required: Scope): boolean {
  return SCOPES.indexOf(granted) >= SCOPES.indexOf(required);
}

/** An extra bearer token for the HTTP MCP server. */
export interface ClientToken {
  token: string;
  scope: Scope;
  /** Shown in the audit log. */
  name?: string;
}
