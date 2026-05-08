import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  comparePlanningArtifactPaths,
  parsePlanningArtifactFileName,
  planningArtifactSlug,
  selectLatestPlanningArtifactPath,
} from '../artifact-names.js';

describe('planning artifact names', () => {
  it('parses brainstorm artifact names with timestamps and slugs', () => {
    assert.deepEqual(
      parsePlanningArtifactFileName('.omx/specs/brainstorm-20260508T020304Z-search-ux.md'),
      {
        kind: 'brainstorm',
        timestamp: '20260508T020304Z',
        slug: 'search-ux',
      },
    );
    assert.equal(
      planningArtifactSlug('.omx/specs/brainstorm-20260508T020304Z-search-ux.md', 'brainstorm'),
      'search-ux',
    );
  });

  it('selects the latest brainstorm artifact by timestamp', () => {
    const paths = [
      '.omx/specs/brainstorm-20260508T010203Z-search-ux.md',
      '.omx/specs/brainstorm-20260508T030405Z-search-ux.md',
      '.omx/specs/brainstorm-20260508T020304Z-search-ux.md',
    ];

    assert.equal(
      selectLatestPlanningArtifactPath(paths),
      '.omx/specs/brainstorm-20260508T030405Z-search-ux.md',
    );
    assert.ok(
      comparePlanningArtifactPaths(paths[0]!, paths[1]!) < 0,
    );
  });
});
