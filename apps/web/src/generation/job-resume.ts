import type { GenerationJob } from './contracts';

export function jobResumeMode(job: Pick<GenerationJob, 'status' | 'chunks'>): 'generate' | 'publication' | undefined {
  if (!['cancelled', 'failed', 'outcome-unknown'].includes(job.status)) return;
  if (job.chunks.some(chunk => ['pending', 'failed', 'audio-ready'].includes(chunk.status))) return 'generate';
  if (job.status === 'failed' && job.chunks.some(chunk => chunk.status === 'completed')
    && job.chunks.every(chunk => chunk.status === 'completed' || chunk.status === 'outcome-unknown')) return 'publication';
}
