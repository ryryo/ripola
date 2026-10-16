export {
  getGenerationConfig, prepareGeneration, startGeneration, listJobs, getJob, getJobPlan,
  cancelJob, prioritizeJobChunks, resumeJob, renameBook,
  getAlignmentCapabilities, startAlignment, listAlignmentJobs, getAlignmentJob,
  cancelAlignmentJob, resumeAlignmentJob,
} from '../generation/functions';
export { getBook, getReadingUpdate, listReadingJobs } from '../generation/functions.reading';
import { listLibrary as requestLibrary } from '../generation/functions.reading';

let pendingLibrary: ReturnType<typeof requestLibrary> | undefined;
/** Share simultaneous consumers, never retain a result across refreshes. */
export function listLibrary() {
  if (pendingLibrary) return pendingLibrary;
  const pending = requestLibrary(); pendingLibrary = pending;
  void pending.finally(() => { if (pendingLibrary === pending) pendingLibrary = undefined; }).catch(() => {});
  return pending;
}
