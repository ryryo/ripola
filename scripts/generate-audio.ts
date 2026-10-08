import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { loadGenerationConfig } from '../apps/web/src/generation/core/config.ts';
import { GenerationService } from '../apps/web/src/generation/core/service.ts';
import type { PrepareGenerationInput } from '../apps/web/src/generation/contracts.ts';

async function main(): Promise<void> {
  const [command, argument, ...flags] = process.argv.slice(2);
  const service = new GenerationService(await loadGenerationConfig());
  await service.ready();
  if (command === 'alignment-jobs') { console.log(JSON.stringify(await service.listAlignmentJobs(), null, 2)); return; }
  if (command === 'align' && argument) {
    const revision = flags.find((flag) => flag.startsWith('--revision='))?.slice('--revision='.length);
    if (!revision) throw new Error('--revision=BOOK_REVISIONで保存済み音声を明示してください。');
    const selectedChunkIds = flags.find((flag) => flag.startsWith('--chunks='))?.slice('--chunks='.length).split(',');
    const job = await service.startAlignment({ bookId: argument, revision, operationId: flags.find((flag) => flag.startsWith('--operation='))?.slice('--operation='.length) ?? randomUUID(), ...(selectedChunkIds ? { selectedChunkIds } : {}) });
    console.log(JSON.stringify(await service.waitForAlignmentJob(job.id), null, 2)); return;
  }
  if (command === 'alignment-cancel' && argument) { console.log(JSON.stringify(await service.cancelAlignmentJob(argument), null, 2)); return; }
  if (command === 'alignment-resume' && argument) {
    const job = await service.resumeAlignmentJob(argument); console.log(JSON.stringify(await service.waitForAlignmentJob(job.id), null, 2)); return;
  }
  if (command === 'config') { console.log(JSON.stringify(await service.getGenerationConfig(), null, 2)); return; }
  if (command === 'jobs') { console.log(JSON.stringify(await service.listJobs(), null, 2)); return; }
  if (command === 'books') { console.log(JSON.stringify(await service.listLibrary(), null, 2)); return; }
  if (command === 'plan' && argument) {
    const input = JSON.parse(await readFile(argument, 'utf8')) as PrepareGenerationInput;
    console.log(JSON.stringify(await service.prepareGeneration(input), null, 2)); return;
  }
  if (command === 'start' && argument) {
    const planHash = argument.replace(/^plan-/, '');
    const job = await service.startGeneration({ planId: argument, planHash, operationId: flags.find((flag) => flag.startsWith('--operation='))?.slice('--operation='.length) ?? randomUUID(), paidConfirmed: flags.includes('--paid-confirmed') });
    console.log(JSON.stringify(await service.waitForJob(job.id), null, 2)); return;
  }
  if (command === 'cancel' && argument) { console.log(JSON.stringify(await service.cancelJob(argument), null, 2)); return; }
  if (command === 'resume' && argument) {
    const plan = await service.getJobPlan(argument);
    if (plan.options.provider === 'gemini' && !flags.includes('--paid-confirmed')) { console.log(JSON.stringify(plan, null, 2)); throw new Error('送信本文・概算を確認し、--paid-confirmedで明示的に再開してください。'); }
    const job = await service.resumeJob(argument, flags.includes('--paid-confirmed'));
    console.log(JSON.stringify(await service.waitForJob(job.id), null, 2)); return;
  }
  throw new Error('Usage: pnpm exec tsx scripts/generate-audio.ts config|jobs|books|plan INPUT.json|start PLAN_ID [--operation=ID] [--paid-confirmed]|cancel JOB_ID|resume JOB_ID [--paid-confirmed]|align BOOK_ID --revision=REV [--chunks=ID,ID] [--operation=ID]|alignment-jobs|alignment-cancel JOB_ID|alignment-resume JOB_ID');
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : '生成処理に失敗しました。'); process.exitCode = 1;
});
