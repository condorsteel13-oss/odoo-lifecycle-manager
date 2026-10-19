import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests/integration', timeout: 45000, workers: 1, use: { trace: 'off', screenshot: 'off' }, reporter: 'list' });
