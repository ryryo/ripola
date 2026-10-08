import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeJobSnapshots } from '../src/generation-ui/job-state.ts';
import type { GenerationJob } from '../src/generation/contracts.ts';

function job(id: string, updatedAt: string, status: GenerationJob['status']): GenerationJob {
  return { schemaVersion: 1, id, updatedAt, status, createdAt: id, operationId: id, planId: id, bookId: id, revision: id, title: id, provider: 'voicevox', chunks: [], completedChunks: 0, totalChunks: 3 };
}

test('a poll begun before start cannot remove the new selected job or roll back cancel/resume progress', () => {
  const oldCompleted = job('old', '01', 'completed');
  const newRunning = job('new', '10', 'running');
  let visible = mergeJobSnapshots([newRunning, oldCompleted], [oldCompleted]);
  assert.equal(visible.find(value => value.id === 'new')?.status, 'running');
  const cancel = job('new', '20', 'cancel-requested');
  visible = mergeJobSnapshots([cancel, oldCompleted], [newRunning, oldCompleted]);
  assert.equal(visible.find(value => value.id === 'new')?.status, 'cancel-requested');
  const completed = job('new', '30', 'completed');
  visible = mergeJobSnapshots(visible, [completed]);
  assert.equal(visible.find(value => value.id === 'new')?.status, 'completed');
});
