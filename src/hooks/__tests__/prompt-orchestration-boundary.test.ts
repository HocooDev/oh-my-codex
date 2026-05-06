import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { listTrackedAgentSurfaces, loadSurface } from './prompt-guidance-test-helpers.js';

const PROMPTS_DIR = join(process.cwd(), 'skills');
const promptFiles = readdirSync(PROMPTS_DIR)
  .filter((name) => name.startsWith('agent-'))
  .map((name) => ({ name, file: join(PROMPTS_DIR, name, 'SKILL.md') }))
  .filter(({ file }) => existsSync(file));

const FORBIDDEN_PROMPT_PATTERNS: Array<[label: string, pattern: RegExp]> = [
  ['direct handoff heading', /Hand off to:|##\s+Hand Off To\b/i],
  ['child request-agent phrasing', /Request\s+\*\*[^*]+\*\*\s+agent/i],
  ['child spawn-agent phrasing', /Spawn\s+the\s+`explore`\s+agent|spawn\s+explore\s+agent/i],
  ['direct delegate-to-agent phrasing', /delegate to specialized agents|delegate to\s+[a-z-]+\s+agent/i],
  ['soft explore-agent routing', /use explore agent|via explore agent/i],
  ['soft next-agent chain phrasing', /next agent in the chain|next agent \(researcher|next agent \(analyst|next agent \(.*planner/i],
  ['soft delegated-checklist phrasing', /delegated to test-engineer/i],
  ['legacy explore-high escalation', /explore-high/i],
  ['external AI routing', /Use an external AI assistant|Use an external long-context AI assistant/i],
];

describe('prompt orchestration boundary', () => {
  for (const entry of promptFiles) {
    it(`${entry.name} avoids recursive orchestration language`, () => {
      const content = readFileSync(entry.file, 'utf-8');
      for (const [label, pattern] of FORBIDDEN_PROMPT_PATTERNS) {
        assert.doesNotMatch(content, pattern, `\${entry.name} should not include ${label}`);
      }
    });
  }

  it('tracked AGENTS surfaces state that child prompts report handoffs upward', () => {
    for (const surface of listTrackedAgentSurfaces()) {
      assert.match(loadSurface(surface), /report recommended handoffs upward/i);
    }
  });

  it('guidance schema documents upward-only handoff limits for role prompts', () => {
    assert.match(loadSurface('docs/guidance-schema.md'), /report upward, do not recursively orchestrate/i);
    assert.match(loadSurface('docs/guidance-schema.md'), /recommend handoffs upward to the orchestrator/i);
  });
});
