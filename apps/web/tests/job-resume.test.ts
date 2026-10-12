import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GenerationJob } from '../src/generation/contracts';
import { jobResumeMode } from '../src/generation/job-resume';

function job(status: GenerationJob['status'], states: GenerationJob['chunks'][number]['status'][]) {
  return { status, chunks: states.map((status, i) => ({ id: `c${i}`, speechKey: `${i}`, status, attempts: 1, reused: false })) };
}
test('resume distinguishes local publication from future synthesis and never resends only unknown speech', () => {
  assert.equal(jobResumeMode(job('failed', ['completed', 'completed'])), 'publication');
  assert.equal(jobResumeMode(job('failed', ['completed', 'outcome-unknown'])), 'publication');
  assert.equal(jobResumeMode(job('outcome-unknown', ['completed', 'outcome-unknown'])), undefined);
  assert.equal(jobResumeMode(job('failed', ['outcome-unknown'])), undefined);
  assert.equal(jobResumeMode(job('failed', [])), undefined);
  for (const status of ['pending', 'failed', 'audio-ready'] as const) assert.equal(jobResumeMode(job('cancelled', ['completed', status, 'outcome-unknown'])), 'generate');
  for (const status of ['queued', 'running', 'cancel-requested', 'completed'] as const) assert.equal(jobResumeMode(job(status, ['completed', 'failed'])), undefined);
});
