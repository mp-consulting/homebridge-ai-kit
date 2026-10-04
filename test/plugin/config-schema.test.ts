import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveAiConfig } from '@mp-consulting/homebridge-ai-core';

interface SchemaNode {
  properties?: Record<string, SchemaNode>;
}

const schema = JSON.parse(readFileSync(new URL('../../config.schema.json', import.meta.url), 'utf8')) as { pluginAlias: string; schema: SchemaNode };

/** A block with every field the code reads set. */
const FULL_BLOCK = {
  name: 'AI Kit',
  enabled: true,
  provider: 'openai-compatible',
  model: 'llama3.1',
  apiKey: 'k',
  baseUrl: 'http://127.0.0.1:11434/v1',
  contextTokens: 8192,
  maxOutputTokens: 2048,
  maxRetries: 2,
  effort: 'medium',
  mcp: {
    http: {
      enabled: true,
      host: '127.0.0.1',
      port: 8582,
      token: 't',
      homebridgeUrl: 'https://127.0.0.1:8581',
      homebridgeToken: 'hbg_x',
      homebridgeCertFingerprint: 'AB:CD',
      homebridgeCertPath: '/certs/ui.pem',
      allowedOrigins: ['https://dash.local'],
      readOnly: true,
      clients: [{ name: 'Dashboard', token: 'r', scope: 'read' }],
      auditLog: true,
      auditLogPath: '/var/lib/homebridge/audit.jsonl',
    },
  },
};

describe('config.schema.json', () => {
  it('describes the HomebridgeAiKit platform', () => {
    expect(schema.pluginAlias).toBe('HomebridgeAiKit');
  });

  // A field missing from the schema is dropped when the Homebridge UI saves the form.
  it('has a property for every field resolveAiConfig reads', () => {
    const { mcp, ...top } = resolveAiConfig(FULL_BLOCK);
    const fields = Object.keys(top).filter((key) => key !== 'platform');
    expect(Object.keys(schema.schema.properties!)).toEqual(expect.arrayContaining(fields));
    expect(Object.keys(schema.schema.properties!.mcp.properties!.http.properties!)).toEqual(expect.arrayContaining(Object.keys(mcp.http)));
  });

  it('describes every field of a client token', () => {
    const { mcp } = resolveAiConfig(FULL_BLOCK);
    const item = (schema.schema.properties!.mcp.properties!.http.properties!.clients as SchemaNode & { items: SchemaNode }).items;
    expect(Object.keys(item.properties!)).toEqual(expect.arrayContaining(Object.keys(mcp.http.clients![0])));
  });

  it('keeps the API token id Glass UI stores to revoke the token', () => {
    expect(schema.schema.properties!.mcp.properties!.http.properties!).toHaveProperty('homebridgeTokenId');
  });
});
