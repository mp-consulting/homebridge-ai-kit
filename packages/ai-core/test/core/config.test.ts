import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MODELS, defaultConfigPath, findAiBlock, readAiConfig, resolveAiConfig } from '../../src/core/config.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveAiConfig', () => {
  it('applies defaults', () => {
    expect(resolveAiConfig()).toEqual({
      platform: 'HomebridgeAiKit',
      name: 'AI Kit',
      enabled: true,
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      maxOutputTokens: 2048,
      mcp: { http: { enabled: false, host: '127.0.0.1', port: 8582 } },
    });
    expect(resolveAiConfig('nonsense').provider).toBe('anthropic');
  });

  it('picks the default model per provider and keeps explicit values', () => {
    for (const provider of ['openai', 'gemini', 'openai-compatible'] as const) {
      expect(resolveAiConfig({ provider }).model).toBe(DEFAULT_MODELS[provider]);
    }
    const config = resolveAiConfig({
      name: ' Mine ',
      enabled: false,
      provider: 'openai-compatible',
      model: 'qwen3',
      apiKey: 'k',
      baseUrl: 'http://lm:1234/v1/',
      maxOutputTokens: '512',
      contextTokens: 32768,
      maxRetries: '0',
      mcp: { http: { enabled: true, host: '0.0.0.0', port: 9000, token: 't', homebridgeUrl: 'https://hb:8581', homebridgeToken: 'hbg_x', homebridgeCertFingerprint: ' AB:CD ', homebridgeCertPath: '/certs/hb.pem' } },
    });
    expect(config).toMatchObject({
      name: 'Mine',
      enabled: false,
      model: 'qwen3',
      apiKey: 'k',
      baseUrl: 'http://lm:1234/v1',
      maxOutputTokens: 512,
      contextTokens: 32768,
      maxRetries: 0,
      mcp: { http: { enabled: true, host: '0.0.0.0', port: 9000, token: 't', homebridgeUrl: 'https://hb:8581', homebridgeToken: 'hbg_x', homebridgeCertFingerprint: 'AB:CD', homebridgeCertPath: '/certs/hb.pem' } },
    });
  });

  it('ignores empty optional strings', () => {
    const config = resolveAiConfig({ apiKey: '  ', baseUrl: '', maxOutputTokens: '', mcp: { http: { token: '' } } });
    expect(config.apiKey).toBeUndefined();
    expect(config.baseUrl).toBeUndefined();
    expect(config.mcp.http.token).toBeUndefined();
  });

  it('rejects unknown providers and bad numbers', () => {
    expect(() => resolveAiConfig({ provider: 'apple' })).toThrow('Unknown AI provider "apple"');
    expect(() => resolveAiConfig({ maxOutputTokens: -1 })).toThrow('maxOutputTokens must be a positive integer');
    expect(() => resolveAiConfig({ effort: 'extreme' })).toThrow('Unknown effort "extreme"');
    expect(resolveAiConfig({ effort: ' xhigh ' }).effort).toBe('xhigh');
    expect(resolveAiConfig({ effort: '' }).effort).toBeUndefined();
    expect(() => resolveAiConfig({ maxRetries: -1 })).toThrow('maxRetries must be a non-negative integer');
    expect(() => resolveAiConfig({ maxRetries: 1.5 })).toThrow('maxRetries');
    expect(resolveAiConfig({ maxRetries: null }).maxRetries).toBeUndefined();
    expect(() => resolveAiConfig({ mcp: { http: { port: 'abc' } } })).toThrow('mcp.http.port');
  });
});

describe('readAiConfig', () => {
  it('defaults to UIX_STORAGE_PATH, else ~/.homebridge', () => {
    vi.stubEnv('UIX_STORAGE_PATH', '/var/lib/homebridge');
    expect(defaultConfigPath()).toBe('/var/lib/homebridge/config.json');
    vi.stubEnv('UIX_STORAGE_PATH', '');
    expect(defaultConfigPath()).toBe(join(homedir(), '.homebridge', 'config.json'));
  });

  it('reads the HomebridgeAiKit block', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aikit-'));
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ platforms: [{ platform: 'Other' }, { platform: 'HomebridgeAiKit', provider: 'gemini', apiKey: 'k' }] }));
    expect(await readAiConfig(path)).toMatchObject({ provider: 'gemini', model: 'gemini-2.5-pro', apiKey: 'k' });

    vi.stubEnv('UIX_STORAGE_PATH', dir);
    expect((await readAiConfig())?.provider).toBe('gemini');
  });

  it('returns null without a file or block, and throws on broken JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aikit-'));
    expect(await readAiConfig(join(dir, 'missing.json'))).toBeNull();
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ platforms: [] }));
    expect(await readAiConfig(path)).toBeNull();
    await writeFile(path, '{');
    await expect(readAiConfig(path)).rejects.toThrow(`Cannot parse ${path}`);
    await expect(readAiConfig(dir)).rejects.toThrow();
  });

  it('findAiBlock tolerates odd shapes', () => {
    expect(findAiBlock(null)).toBeUndefined();
    expect(findAiBlock({ platforms: 'x' })).toBeUndefined();
    expect(findAiBlock({ platforms: [null, { platform: 'HomebridgeAiKit' }] })).toEqual({ platform: 'HomebridgeAiKit' });
  });
});
