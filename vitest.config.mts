import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const core = (path: string) => fileURLToPath(new URL(`./packages/ai-core/src/${path}`, import.meta.url));

export default defineConfig({
  // Tests run against the ai-core sources, so they need no build. ai-core has its own vitest config and coverage.
  resolve: {
    alias: [
      { find: /^@mp-consulting\/homebridge-ai-core\/plugin$/, replacement: core('plugin/index.ts') },
      { find: /^@mp-consulting\/homebridge-ai-core$/, replacement: core('index.ts') },
    ],
  },
  test: {
    environment: 'node',
    globals: true,
    include: [
      'src/**/*.{test,spec}.ts',
      'test/**/*.{test,spec}.ts',
      'tests/**/*.{test,spec}.ts',
    ],
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // bin/ and stdio.ts only wire env vars to createServer() and stdio, which is covered by create-server.test.ts.
      exclude: ['src/**/*.{test,spec}.ts', 'src/**/__tests__/**', 'src/bin/**', 'src/mcp/stdio.ts'],
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 95,
        lines: 95,
      },
    },
  },
  oxc: {
    target: 'es2022',
  },
});
