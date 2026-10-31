import { defineConfig } from 'vitest/config'

// Multi-user RLS suite. It runs in Node against the real local Supabase stack
// through anon-key clients, so it loads none of the unit-test setup or mocks.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/rls/**/*.test.ts'],
    globalSetup: ['tests/rls/globalSetup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
