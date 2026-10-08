import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { classifyChanges } from './ci-scope.mjs';

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const manual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
let paths = [];
let uncertain = false;
if (!manual) {
  const pr = event.pull_request;
  const before = pr ? pr.base.sha : event.before;
  const after = pr ? pr.head.sha : event.after;
  if (!/^[a-f0-9]{40}$/.test(before ?? '') || /^0+$/.test(before) || !/^[a-f0-9]{40}$/.test(after ?? '')) uncertain = true;
  else {
    // PR merge-base comparison; push before/after includes every pushed commit, including renames/deletions.
    const diff = spawnSync('git', ['diff', '--name-only', '-z', '--no-renames', pr ? `${before}...${after}` : before, ...(pr ? [] : [after]), '--'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (diff.status !== 0 || diff.error) uncertain = true;
    else paths = diff.stdout.split('\0').filter(Boolean);
  }
}
const scope = classifyChanges(paths, { manual, uncertain });
const output = `code=${scope.code}\nmode=${scope.mode}\ndomains=${scope.domains.join(',')}\npython=${scope.python}\n`;
appendFileSync(process.env.GITHUB_OUTPUT, output);
console.log(JSON.stringify({ ...scope, changedFileCount: paths.length }));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## CI scope\n\n${scope.reason}; mode: ${scope.mode}; domains: ${scope.domains.join(', ') || 'none'}; files: ${paths.length}.\n`);
