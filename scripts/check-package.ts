// Static release inspection: never starts the app or opens an account session.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const appPath = resolve(process.argv[2] ?? 'release/mac-universal/Odoo Lifecycle Manager.app');
for (const relative of ['Contents/MacOS/Odoo Lifecycle Manager', 'Contents/Resources/chrome-background', 'Contents/Resources/chrome-recovery', 'Contents/Resources/update-installer']) {
  const architectures=execFileSync('lipo',['-archs',join(appPath,relative)],{encoding:'utf8'}).trim().split(/\s+/);
  if(!architectures.includes('arm64')||!architectures.includes('x86_64'))throw new Error(`Missing architecture: ${relative}`);
  console.log(`${relative}: ${architectures.join(', ')}`);
}
if(existsSync(join(appPath,'Contents/Resources/browser-binaries')))throw new Error('Test browsers must not ship.');
const version=JSON.parse(readFileSync('package.json','utf8')).version;
const plist=execFileSync('plutil',['-convert','json','-o','-',join(appPath,'Contents/Info.plist')],{encoding:'utf8'});
const info=JSON.parse(plist);
if(info.CFBundleShortVersionString!==version||info.LSMinimumSystemVersion!=='13.0')throw new Error('Release metadata mismatch.');
console.log(`Universal v${version}, macOS 13+; no account access or mutations performed.`);
