import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertBuiltinExploreHarnessSupported,
  getBuiltinExploreHarnessUnsupportedReason,
} from '../explore.js';

describe('explore Windows built-in harness diagnostics', () => {
  it('reports the built-in harness as unsupported on Windows unless a custom override is set', () => {
    assert.match(
      getBuiltinExploreHarnessUnsupportedReason('win32', {} as NodeJS.ProcessEnv, '/missing-package-root') || '',
      /not ready on Windows/i,
    );
    assert.equal(
      getBuiltinExploreHarnessUnsupportedReason('win32', { OMX_EXPLORE_BIN: 'custom-harness.exe' } as NodeJS.ProcessEnv),
      undefined,
    );
    assert.equal(getBuiltinExploreHarnessUnsupportedReason('linux', {} as NodeJS.ProcessEnv), undefined);
  });

  it('fails early with actionable guidance for the built-in harness on Windows', () => {
    assert.throws(
      () => assertBuiltinExploreHarnessSupported('win32', {} as NodeJS.ProcessEnv, '/missing-package-root'),
      /built-in explore harness is not ready on Windows/i,
    );
    assert.doesNotThrow(() => assertBuiltinExploreHarnessSupported('win32', {
      OMX_EXPLORE_BIN: 'custom-harness.exe',
    } as NodeJS.ProcessEnv));
  });

  it('treats the packaged Windows custom harness as a supported built-in path', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-explore-windows-packaged-'));
    try {
      await mkdir(join(wd, 'src', 'scripts'), { recursive: true });
      await mkdir(join(wd, 'dist', 'scripts'), { recursive: true });
      await writeFile(join(wd, 'src', 'scripts', 'explore-windows-harness.ps1'), 'Write-Output harness');
      await writeFile(join(wd, 'dist', 'scripts', 'explore-windows-harness.js'), 'console.log("harness");');

      assert.equal(
        getBuiltinExploreHarnessUnsupportedReason('win32', {} as NodeJS.ProcessEnv, wd),
        undefined,
      );
      assert.doesNotThrow(() => assertBuiltinExploreHarnessSupported('win32', {} as NodeJS.ProcessEnv, wd));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
