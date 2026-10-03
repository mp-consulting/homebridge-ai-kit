import { defineConfig } from 'vitest/config';

export default defineConfig({
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
      // index.ts only wires env vars to createServer() and stdio, which is covered by create-server.test.ts.
      exclude: ['src/**/*.{test,spec}.ts', 'src/**/__tests__/**', 'src/index.ts'],
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
