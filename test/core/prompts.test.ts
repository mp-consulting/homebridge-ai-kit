import { describe, expect, it } from 'vitest';
import { PROMPTS } from '../../src/core/prompts.js';

describe('PROMPTS', () => {
  it('fills every template', () => {
    expect(PROMPTS.diagnoseLogs.user({ logs: 'L', focus: 'hue' })).toContain('Focus on: hue');
    expect(PROMPTS.diagnoseLogs.user({ logs: 'L' })).not.toContain('Focus');
    expect(PROMPTS.generatePluginConfig.user({ request: 'r', schema: {}, current: { a: 1 }, pluginName: 'p' })).toContain('## Current config');
    expect(PROMPTS.generatePluginConfig.user({ request: 'r', schema: {} })).not.toContain('Current config');
    expect(PROMPTS.explainDeviceError.user({ error: 'E', device: { id: 1 }, context: 'C', pluginName: 'p' })).toContain('## Context\nC');
    expect(PROMPTS.explainDeviceError.user({ error: 'E' })).not.toContain('## Device');
    expect(PROMPTS.assessPluginUpdate.user({ pluginName: 'p', currentVersion: '1', targetVersion: '2', changelog: 'c' })).toContain('from 1 to 2');
    expect(PROMPTS.suggestOrganization.user({ accessories: [], rooms: [] })).toContain('## Current rooms');
    expect(PROMPTS.suggestOrganization.user({ accessories: [] })).not.toContain('Current rooms');
    expect(PROMPTS.dailyDigest.user({ date: 'd', status: {}, logs: 'l', updates: [], accessories: [] })).toContain('## Available updates');
    expect(PROMPTS.dailyDigest.user({ date: 'd' })).toBe('Write the Homebridge digest for d.');
    expect(PROMPTS.ask.user({ prompt: 'q', context: 'c' })).toBe('q\n\n## Context\nc');
    expect(PROMPTS.repairJson('bad')).toContain('bad');
  });

  it('has the MCP prompt texts', () => {
    expect(PROMPTS.mcp['diagnose-logs'].text({ focus: 'x' })).toContain('Focus on: x');
    expect(PROMPTS.mcp['diagnose-logs'].text({})).toContain('get_recent_logs');
    expect(PROMPTS.mcp['plan-upgrade'].text({ plugin: 'homebridge-hue' })).toContain('homebridge-hue');
    expect(PROMPTS.mcp['plan-upgrade'].text({})).toContain('installed Homebridge plugins');
    expect(PROMPTS.mcp['audit-config'].text()).toContain('get_config');
  });
});
