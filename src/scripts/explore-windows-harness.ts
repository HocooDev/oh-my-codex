#!/usr/bin/env node

import { runWindowsExploreHarnessCli } from '../cli/explore-windows-harness.js';

runWindowsExploreHarnessCli().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[omx explore] ${message}\n`);
  process.exitCode = 1;
});
