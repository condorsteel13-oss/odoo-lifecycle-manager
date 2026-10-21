import * as nodeFs from 'node:fs';
import { createRequire } from 'node:module';

// Replacement bundles contain app.asar. Electron's normal fs interprets it as
// a virtual read-only directory, breaking both extraction and recursive cleanup.
// Keep these disk operations separate from the app's normal ASAR-aware imports.
export const updateDisk: typeof nodeFs = process.versions.electron
  ? createRequire(process.execPath)('original-fs')
  : nodeFs;
