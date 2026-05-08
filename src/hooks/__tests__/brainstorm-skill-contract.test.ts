import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const brainstormSkill = readFileSync(
  join(__dirname, '../../../skills/brainstorm/SKILL.md'),
  'utf-8',
);

describe('brainstorm skill contract', () => {
  it('positions brainstorm before deep-interview and ralplan without executing code changes', () => {
    assert.match(brainstormSkill, /before `?\$deep-interview`? and `?\$ralplan`?/i);
    assert.match(brainstormSkill, /Do not implement code/i);
    assert.match(brainstormSkill, /Do not create the final execution plan/i);
    assert.match(brainstormSkill, /Do not invoke `?\$ralph`?, `?\$team`?, or `?\$autopilot`?/i);
  });

  it('requires the default multi-agent orchestration lanes', () => {
    assert.match(brainstormSkill, /Repo context lane.*agent-explore/i);
    assert.match(brainstormSkill, /Architecture lane.*agent-architect/i);
    assert.match(brainstormSkill, /Drafting lane.*agent-writer/i);
    assert.match(brainstormSkill, /Review lane/i);
    assert.match(brainstormSkill, /Launch the repo context lane and architecture lane in parallel/i);
  });

  it('documents optional external advisors as disabled by default', () => {
    assert.match(brainstormSkill, /optional and disabled by default/i);
    assert.match(brainstormSkill, /--with-claude/i);
    assert.match(brainstormSkill, /--with-gemini/i);
    assert.match(brainstormSkill, /omx ask claude/i);
    assert.match(brainstormSkill, /omx ask gemini/i);
  });

  it('requires report output in the user language and a stable brainstorm artifact contract', () => {
    assert.match(brainstormSkill, /must match the user's language environment/i);
    assert.match(brainstormSkill, /\.omx\/specs\/brainstorm-<timestamp>-<slug>\.md/i);
    assert.match(brainstormSkill, /# Brainstorm Report:/i);
    assert.match(brainstormSkill, /## 9\. Recommendation/i);
    assert.match(brainstormSkill, /## 15\. Ralplan Handoff/i);
    assert.match(brainstormSkill, /## 16\. Handoff Decision/i);
    assert.match(brainstormSkill, /Approved recommendation:/i);
    assert.match(brainstormSkill, /Suggested next command:/i);
    assert.match(brainstormSkill, /Handoff Decision:/i);
    assert.match(brainstormSkill, /type: brainstorm_design_report/i);
    assert.match(brainstormSkill, /recommended_next_skill: deep-interview \| ralplan \| none/i);
    assert.match(brainstormSkill, /must not auto-trigger/i);
  });
});
