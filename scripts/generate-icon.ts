import { chromium } from 'playwright';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
const revision = readdirSync('browser-binaries').find(n => /^chromium-/.test(n))!;
const browser = await chromium.launch({ headless: true, executablePath: resolve('browser-binaries', revision, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing') });
try { const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } }); await page.setContent(`<body style="margin:0;background:transparent">${readFileSync('assets/icon.svg', 'utf8')}</body>`); await page.screenshot({ path: 'assets/icon.png', omitBackground: true }); } finally { await browser.close(); }
