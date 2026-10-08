import { createServerFn } from '@tanstack/react-start';
import type { StartAlignmentInput, PrepareGenerationInput, ResumeGenerationInput, StartGenerationInput } from './contracts';
import { getLocalGenerationService } from './service.server';

export const getGenerationConfig = createServerFn({ method: 'GET' }).handler(async () => (await getLocalGenerationService()).getGenerationConfig());
export const prepareGeneration = createServerFn({ method: 'POST' }).validator((data: PrepareGenerationInput) => data).handler(async ({ data }) => (await getLocalGenerationService()).prepareGeneration(data));
export const startGeneration = createServerFn({ method: 'POST' }).validator((data: StartGenerationInput) => data).handler(async ({ data }) => (await getLocalGenerationService()).startGeneration(data));
export const listJobs = createServerFn({ method: 'GET' }).handler(async () => (await getLocalGenerationService()).listJobs());
export const getJob = createServerFn({ method: 'GET' }).validator((data: { jobId: string }) => data).handler(async ({ data }) => (await getLocalGenerationService()).getJob(data.jobId));
export const getJobPlan = createServerFn({ method: 'GET' }).validator((data: { jobId: string }) => data).handler(async ({ data }) => (await getLocalGenerationService()).getJobPlan(data.jobId));
export const cancelJob = createServerFn({ method: 'POST' }).validator((data: { jobId: string }) => data).handler(async ({ data }) => (await getLocalGenerationService()).cancelJob(data.jobId));
export const resumeJob = createServerFn({ method: 'POST' }).validator((data: ResumeGenerationInput) => data).handler(async ({ data }) => (await getLocalGenerationService()).resumeJob(data.jobId, data.paidConfirmed));
export const listLibrary = createServerFn({ method: 'GET' }).handler(async () => (await getLocalGenerationService()).listLibrary());
export const getBook = createServerFn({ method: 'GET' }).validator((data: { bookId: string; revision?: string }) => data).handler(async ({ data }) => (await getLocalGenerationService()).getBook(data.bookId, data.revision));

export const getAlignmentCapabilities = createServerFn({ method: 'GET' }).handler(async () => (await getLocalGenerationService()).getAlignmentCapabilities());
export const startAlignment = createServerFn({ method: 'POST' }).validator((data: StartAlignmentInput) => data).handler(async ({ data }) => (await getLocalGenerationService()).startAlignment(data));
export const listAlignmentJobs = createServerFn({ method: 'GET' }).handler(async () => (await getLocalGenerationService()).listAlignmentJobs());
export const getAlignmentJob = createServerFn({ method: 'GET' }).validator((data: { jobId: string }) => data).handler(async ({ data }) => (await getLocalGenerationService()).getAlignmentJob(data.jobId));
export const cancelAlignmentJob = createServerFn({ method: 'POST' }).validator((data: { jobId: string }) => data).handler(async ({ data }) => (await getLocalGenerationService()).cancelAlignmentJob(data.jobId));
export const resumeAlignmentJob = createServerFn({ method: 'POST' }).validator((data: { jobId: string }) => data).handler(async ({ data }) => (await getLocalGenerationService()).resumeAlignmentJob(data.jobId));

export const renameBook = createServerFn({ method: 'POST' }).validator((data: { bookId: string; revision: string; title: string }) => data).handler(async ({ data }) => (await getLocalGenerationService()).renameBook(data.bookId, data.revision, data.title));
