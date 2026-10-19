import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
await build({ entryPoints: ['electron/main.ts', 'electron/preload.ts'], outdir: 'dist-electron', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron', 'playwright', 'playwright-core'], sourcemap: true });
if (process.platform === 'darwin') {
  const cache = 'dist-electron/swift-module-cache';
  mkdirSync(cache, { recursive: true });
  const binaries = ['arm64', 'x86_64'].map(arch => {
    const output = `dist-electron/chrome-background-${arch}`;
    execFileSync('xcrun', ['swiftc', 'native/chrome-background.swift', '-target', `${arch}-apple-macos13.0`, '-module-cache-path', cache, '-o', output, '-O'], { stdio: 'inherit' });
    return output;
  });
  execFileSync('lipo', ['-create', ...binaries, '-output', 'dist-electron/chrome-background'], { stdio: 'inherit' });
}
