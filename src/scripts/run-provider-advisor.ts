#!/usr/bin/env node
import process from 'node:process';
import {
  executeProviderAdvisor,
  PROVIDER_ADVISORS,
  type ProviderAdvisorName,
} from '../cli/provider-advisor.js';

const ASK_ORIGINAL_TASK_ENV = 'OMX_ASK_ORIGINAL_TASK';

function usage(): void {
  console.error('Usage: omx ask <claude|gemini> "<prompt>"');
  console.error('Legacy direct usage: node scripts/run-provider-advisor.js <claude|gemini> <prompt...>');
  console.error('                 or: node scripts/run-provider-advisor.js claude --print "<prompt>"');
  console.error('                 or: node scripts/run-provider-advisor.js gemini --prompt "<prompt>"');
}

function parseArgs(argv: string[]): { provider: ProviderAdvisorName; prompt: string } {
  const [providerRaw, ...rest] = argv;
  const provider = (providerRaw || '').toLowerCase();

  if (!provider || !PROVIDER_ADVISORS.includes(provider as ProviderAdvisorName)) {
    usage();
    process.exit(1);
  }

  if (rest.length === 0) {
    usage();
    process.exit(1);
  }

  if (rest[0] === '-p' || rest[0] === '--print' || rest[0] === '--prompt') {
    const prompt = rest.slice(1).join(' ').trim();
    if (!prompt) {
      usage();
      process.exit(1);
    }
    return { provider: provider as ProviderAdvisorName, prompt };
  }

  return { provider: provider as ProviderAdvisorName, prompt: rest.join(' ').trim() };
}

async function main(): Promise<void> {
  const { provider, prompt } = parseArgs(process.argv.slice(2));
  const originalTask = process.env[ASK_ORIGINAL_TASK_ENV] ?? prompt;
  const result = await executeProviderAdvisor({
    provider,
    prompt,
    originalTask,
    cwd: process.cwd(),
    env: process.env,
  });

  console.log(result.artifactPath);
  if (result.status !== 'succeeded') {
    process.exit(result.exitCode);
  }
}

main().catch((error) => {
  console.error(`[run-provider-advisor] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
