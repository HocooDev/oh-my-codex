import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  deriveRalplanTaskFromDesign,
  parseRalplanTaskForDesignInput,
  resolveRalplanTaskContext,
} from '../design-intake.js';
import { readBrainstormArtifact } from '../../planning/artifacts.js';

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'omx-ralplan-design-intake-'));
}

function validBrainstormReport(fileName: string, recommendedNextSkill: 'ralplan' | 'deep-interview' | 'none' = 'ralplan'): string {
  return [
    '# Brainstorm Report: Search UX',
    '',
    '## 9. Recommendation',
    'Approved recommendation: Implement the incremental search UX with a shared debounce layer.',
    '',
    '## 15. Ralplan Handoff',
    `Suggested next command: $ralplan --from-design .omx/specs/${fileName} "Turn the approved search UX direction into a PRD and test spec"`,
    '',
    '## 16. Handoff Decision',
    'Handoff Decision: Approved for planning after design review.',
    '',
    'artifact:',
    '  type: brainstorm_design_report',
    `  path: .omx/specs/${fileName}`,
    '  status: approved',
    `  recommended_next_skill: ${recommendedNextSkill}`,
    '',
  ].join('\n');
}

describe('ralplan design intake', () => {
  it('parses and strips the --from-design flag from the task text', () => {
    assert.deepEqual(
      parseRalplanTaskForDesignInput('--from-design ".omx/specs/brainstorm-20260508T020304Z-search.md" tighten the execution plan'),
      {
        fromDesignPath: '.omx/specs/brainstorm-20260508T020304Z-search.md',
        taskWithoutFlag: 'tighten the execution plan',
      },
    );
  });

  it('derives a fallback task from omx ralplan commands and strips supported flags', async () => {
    const workspace = await createWorkspace();
    try {
      const specsDir = join(workspace, '.omx', 'specs');
      await mkdir(specsDir, { recursive: true });
      const fileName = 'brainstorm-20260508T020304Z-search-flags.md';
      const reportPath = join(specsDir, fileName);
      await writeFile(
        reportPath,
        validBrainstormReport(fileName).replace(
          `$ralplan --from-design .omx/specs/${fileName} "Turn the approved search UX direction into a PRD and test spec"`,
          'omx ralplan --from-design .omx/specs/brainstorm-20260508T020304Z-search-flags.md --interactive --deliberate "Turn the approved search UX direction into a PRD and test spec"',
        ),
      );

      const record = readBrainstormArtifact(reportPath, workspace);
      assert.ok(record);
      assert.equal(
        deriveRalplanTaskFromDesign(record!),
        'Turn the approved search UX direction into a PRD and test spec',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('derives a fallback task from the brainstorm suggested next command', async () => {
    const workspace = await createWorkspace();
    try {
      const specsDir = join(workspace, '.omx', 'specs');
      await mkdir(specsDir, { recursive: true });
      const fileName = 'brainstorm-20260508T020304Z-search.md';
      const reportPath = join(specsDir, fileName);
      await writeFile(reportPath, validBrainstormReport(fileName));

      const record = readBrainstormArtifact(reportPath, workspace);
      assert.ok(record);
      assert.equal(
        deriveRalplanTaskFromDesign(record!),
        'Turn the approved search UX direction into a PRD and test spec',
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('accepts an approved brainstorm report as design input for ralplan', async () => {
    const workspace = await createWorkspace();
    try {
      const specsDir = join(workspace, '.omx', 'specs');
      await mkdir(specsDir, { recursive: true });
      const fileName = 'brainstorm-20260508T020304Z-search.md';
      await writeFile(join(specsDir, fileName), validBrainstormReport(fileName));

      const result = resolveRalplanTaskContext(workspace, `--from-design .omx/specs/${fileName}`);
      assert.equal(result.status, 'ok');
      if (result.status !== 'ok') return;
      assert.equal(result.value.task, 'Turn the approved search UX direction into a PRD and test spec');
      assert.equal(result.value.designInput?.recommendedNextSkill, 'ralplan');
      assert.equal(result.value.designInput?.sourcePath, join(specsDir, fileName));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('accepts the latest canonical brainstorm report via --from-design latest', async () => {
    const workspace = await createWorkspace();
    try {
      const specsDir = join(workspace, '.omx', 'specs');
      await mkdir(specsDir, { recursive: true });
      await writeFile(
        join(specsDir, 'brainstorm-20260508T020304Z-older.md'),
        validBrainstormReport('brainstorm-20260508T020304Z-older.md'),
      );
      await writeFile(
        join(specsDir, 'brainstorm-20260508T020305Z-latest.md'),
        validBrainstormReport('brainstorm-20260508T020305Z-latest.md'),
      );

      const result = resolveRalplanTaskContext(workspace, '--from-design latest');
      assert.equal(result.status, 'ok');
      if (result.status !== 'ok') return;
      assert.equal(result.value.designInput?.sourcePath, join(specsDir, 'brainstorm-20260508T020305Z-latest.md'));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects brainstorm reports that are missing the handoff block', async () => {
    const workspace = await createWorkspace();
    try {
      const specsDir = join(workspace, '.omx', 'specs');
      await mkdir(specsDir, { recursive: true });
      const fileName = 'brainstorm-20260508T020304Z-bad.md';
      await writeFile(
        join(specsDir, fileName),
        [
          '# Brainstorm Report: Bad',
          '',
          '## 9. Recommendation',
          'Approved recommendation: Something vague.',
          '',
          '## 16. Handoff Decision',
          'Handoff Decision: Maybe later.',
          '',
        ].join('\n'),
      );

      const result = resolveRalplanTaskContext(workspace, `--from-design .omx/specs/${fileName}`);
      assert.equal(result.status, 'invalid');
      if (result.status !== 'invalid') return;
      assert.match(result.error, /Missing required anchors/i);
      assert.equal(result.errorCode, 'design_input_missing_anchors');
      assert.deepEqual(result.missingAnchors, [
        '## 15. Ralplan Handoff',
        'Suggested next command',
        'artifact.type = brainstorm_design_report',
        'artifact.path',
        'recommended_next_skill',
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects brainstorm reports that are not approved for ralplan', async () => {
    const workspace = await createWorkspace();
    try {
      const specsDir = join(workspace, '.omx', 'specs');
      await mkdir(specsDir, { recursive: true });
      const noneFileName = 'brainstorm-20260508T020304Z-none.md';
      const interviewFileName = 'brainstorm-20260508T020305Z-interview.md';
      await writeFile(join(specsDir, noneFileName), validBrainstormReport(noneFileName, 'none'));
      await writeFile(join(specsDir, interviewFileName), validBrainstormReport(interviewFileName, 'deep-interview'));

      const noneResult = resolveRalplanTaskContext(workspace, `--from-design .omx/specs/${noneFileName}`);
      assert.equal(noneResult.status, 'invalid');
      if (noneResult.status === 'invalid') {
        assert.equal(noneResult.errorCode, 'design_input_no_planning_handoff');
        assert.match(noneResult.error, /recommended_next_skill: none/i);
      }

      const interviewResult = resolveRalplanTaskContext(workspace, `--from-design .omx/specs/${interviewFileName}`);
      assert.equal(interviewResult.status, 'invalid');
      if (interviewResult.status === 'invalid') {
        assert.equal(interviewResult.errorCode, 'design_input_requires_deep_interview');
        assert.match(interviewResult.error, /\$deep-interview/i);
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects draft brainstorm reports even when they point at ralplan', async () => {
    const workspace = await createWorkspace();
    try {
      const specsDir = join(workspace, '.omx', 'specs');
      await mkdir(specsDir, { recursive: true });
      const fileName = 'brainstorm-20260508T020306Z-draft.md';
      await writeFile(
        join(specsDir, fileName),
        validBrainstormReport(fileName).replace('status: approved', 'status: draft'),
      );

      const result = resolveRalplanTaskContext(workspace, `--from-design .omx/specs/${fileName}`);
      assert.equal(result.status, 'invalid');
      if (result.status !== 'invalid') return;
      assert.equal(result.errorCode, 'design_input_not_approved');
      assert.match(result.error, /artifact\.status: draft/i);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects superseded brainstorm reports even when they point at ralplan', async () => {
    const workspace = await createWorkspace();
    try {
      const specsDir = join(workspace, '.omx', 'specs');
      await mkdir(specsDir, { recursive: true });
      const fileName = 'brainstorm-20260508T020308Z-superseded.md';
      await writeFile(
        join(specsDir, fileName),
        validBrainstormReport(fileName).replace('status: approved', 'status: superseded'),
      );

      const result = resolveRalplanTaskContext(workspace, `--from-design .omx/specs/${fileName}`);
      assert.equal(result.status, 'invalid');
      if (result.status !== 'invalid') return;
      assert.equal(result.errorCode, 'design_input_not_approved');
      assert.match(result.error, /artifact\.status: superseded/i);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects valid-looking brainstorm files outside the canonical specs directory', async () => {
    const workspace = await createWorkspace();
    try {
      const reportPath = join(workspace, 'brainstorm-20260508T020307Z-outside.md');
      await writeFile(
        reportPath,
        validBrainstormReport('brainstorm-20260508T020307Z-outside.md'),
      );

      const result = resolveRalplanTaskContext(workspace, `--from-design "${reportPath}"`);
      assert.equal(result.status, 'invalid');
      if (result.status !== 'invalid') return;
      assert.equal(result.errorCode, 'design_input_not_canonical');
      assert.match(result.error, /not a canonical/i);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
