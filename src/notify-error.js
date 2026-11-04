// Posts a Components V2 failure report to ERROR_WEBHOOK from inside a GitHub Actions run.
// Run from a final `if: failure()` step. Needs `actions: read` for step names + log excerpts.
const USER_ID = '1366222155720687646';
const LOGO_URL = 'https://raw.githubusercontent.com/CloudWaddie/ModelWatcher/master/logo.jpg';

const env = process.env;
const repo = env.GITHUB_REPOSITORY;
const runId = env.GITHUB_RUN_ID;
const runUrl = `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/runs/${runId}`;

async function gh(path, text = false) {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
  return text ? res.text() : res.json();
}

// "Error excerpt": lines around the first ##[error], with timestamps / ANSI / group markers stripped.
function excerpt(log, max = 1400) {
  const lines = log.split('\n')
    .map(l => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\x1b\[[0-9;]*m/g, '').trimEnd())
    .filter(l => l && !l.startsWith('##[group]') && !l.startsWith('##[endgroup]'));
  const errIdx = lines.findIndex(l => l.startsWith('##[error]'));
  const start = Math.max(0, (errIdx === -1 ? lines.length : errIdx + 1) - 14);
  let out = lines.slice(start, errIdx === -1 ? lines.length : Math.min(lines.length, errIdx + 4))
    .map(l => l.replace(/^##\[error\]/, '✖ ')).join('\n');
  if (out.length > max) out = '…' + out.slice(-max);
  return out.replace(/```/g, "'''");
}

async function collect() {
  const failed = [];
  try {
    const { jobs } = await gh(`/actions/runs/${runId}/jobs?per_page=50`);
    for (const job of jobs) {
      const steps = (job.steps ?? []).filter(s => s.conclusion === 'failure');
      if (job.conclusion !== 'failure' && !steps.length) continue;
      let log = '';
      try { log = excerpt(await gh(`/actions/jobs/${job.id}/logs`, true)); } catch (e) { log = `(log unavailable: ${e.message})`; }
      failed.push({ job: job.name, step: steps.map(s => s.name).join(', ') || '(unknown step)', log });
    }
  } catch (e) {
    failed.push({ job: '(unknown)', step: '(unknown)', log: `Could not read run details: ${e.message}` });
  }
  return failed;
}

function buildPayload(failed) {
  const sha = (env.GITHUB_SHA ?? '').slice(0, 7);
  const components = [
    { type: 10, content: `<@${USER_ID}>\n# ❌ ${env.GITHUB_WORKFLOW ?? 'Workflow'} failed` },
    { type: 10, content: `**Trigger:** ${env.GITHUB_EVENT_NAME ?? '?'} · **Branch:** \`${env.GITHUB_REF_NAME ?? '?'}\` · **Commit:** \`${sha}\` · **Run:** #${env.GITHUB_RUN_NUMBER ?? '?'}` },
  ];
  for (const f of failed.slice(0, 3)) {
    components.push({ type: 14 });
    components.push({ type: 10, content: `**Job:** ${f.job}\n**Failed step:** ${f.step}` });
    if (f.log) components.push({ type: 10, content: '```\n' + f.log + '\n```' });
  }
  components.push({ type: 14 });
  components.push({ type: 1, components: [{ type: 2, style: 5, label: 'View run', url: runUrl }] });
  return {
    username: 'ModelWatcher Errors',
    avatar_url: LOGO_URL,
    flags: 32768,
    allowed_mentions: { users: [USER_ID] },
    components: [{ type: 17, accent_color: 0xED4245, components }],
  };
}

async function main() {
  if (!env.ERROR_WEBHOOK) { console.log('ERROR_WEBHOOK not set - skipping failure ping'); return; }
  const payload = buildPayload(await collect());
  if (process.argv.includes('--dry-run')) { console.log(JSON.stringify(payload, null, 2)); return; }
  const res = await fetch(env.ERROR_WEBHOOK + '?with_components=true', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (res.ok) console.log('Failure notification sent');
  else console.error('Discord send failed:', res.status, await res.text());
}

main().catch(e => { console.error('notify-error failed:', e); });
