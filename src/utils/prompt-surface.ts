import { existsSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

export const LEGACY_PROMPT_SURFACE_SKILL_PREFIX = 'agent-';

export function promptSurfaceSkillName(surfaceName: string): string {
  return `${LEGACY_PROMPT_SURFACE_SKILL_PREFIX}${surfaceName}`;
}

export function promptSurfaceSkillPath(skillsDir: string, surfaceName: string): string {
  return join(skillsDir, promptSurfaceSkillName(surfaceName), 'SKILL.md');
}

export function legacyPromptSurfacePath(promptsDir: string, surfaceName: string): string {
  return join(promptsDir, `${surfaceName}.md`);
}

export async function loadPromptSurfaceFromSkills(
  surfaceName: string,
  skillsDir: string,
): Promise<string | null> {
  const skillPath = promptSurfaceSkillPath(skillsDir, surfaceName);
  try {
    const content = await readFile(skillPath, 'utf-8');
    return content.trim() || null;
  } catch {
    return null;
  }
}

export function hasPromptSurfaceSkill(
  surfaceName: string,
  skillsDir: string,
): boolean {
  return existsSync(promptSurfaceSkillPath(skillsDir, surfaceName));
}

export async function listPromptSurfacesFromSkills(
  skillsDir: string,
): Promise<string[]> {
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(LEGACY_PROMPT_SURFACE_SKILL_PREFIX))
      .filter((entry) => existsSync(join(skillsDir, entry.name, 'SKILL.md')))
      .map((entry) => entry.name.slice(LEGACY_PROMPT_SURFACE_SKILL_PREFIX.length))
      .sort();
  } catch {
    return [];
  }
}
