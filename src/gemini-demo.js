import { progressBar, buildProgressPayload, buildReport, patchMessage } from './gemini-watch.js';

/**
 * Demo: simulates a full Gemini RPC scan against the live Discord webhook
 * (TOMBSTONE_WEBHOOK) so you can watch the progress bar animate, then see
 * what a diff report looks like. Nothing is actually scraped — the progress
 * timeline and report data are fabricated.
 *
 * Usage: TOMBSTONE_WEBHOOK=<url> npm run gemini-demo
 */

const WEBHOOK_URL = process.env.TOMBSTONE_WEBHOOK;
if (!WEBHOOK_URL) {
  console.error('Set TOMBSTONE_WEBHOOK to the Discord webhook URL first.');
  process.exit(1);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Simulated scan timeline (module fetch -> extraction -> done)
const MODULES_TOTAL = 675;
const CHUNKS_TOTAL = 675;
const FINAL_MAPPINGS = 327;

// Sample "previous state" — includes an RPC that will appear REMOVED,
// one CHANGED (different path), and one with a type change, so the report
// shows every section.
const SAMPLE_PREV = {
  mappings: {
    'Te6DCf': 'BardFrontendService.ListDiscoveryBanners',
    'KKERBf': 'BardFrontendService.StartPhoneVerification',
    'MgfGLc': 'BardFrontendService.ListMcpTools',
    'OldRpc': 'BardFrontendService.DeprecatedThing',
    'ChgRpc': 'BardFrontendService.OldMethodName',
    'TypRpc': 'BardFrontendService.UnchangedPath',
  },
  types: {
    'Te6DCf': 'unary',
    'KKERBf': 'unary',
    'MgfGLc': 'unary',
    'OldRpc': 'unary',
    'ChgRpc': 'server_streaming',
    'TypRpc': 'unary',
  },
};

// Simulated "current" mappings — note: no OldRpc, ChgRpc moved, TypRpc changed type.
const SAMPLE_CURRENT = new Map(Object.entries({
  'Te6DCf': 'BardFrontendService.ListDiscoveryBanners',
  'KKERBf': 'BardFrontendService.StartPhoneVerification',
  'MgfGLc': 'BardFrontendService.ListMcpTools',
  'ChgRpc': 'BardFrontendService.RenamedMethod',
  'TypRpc': 'BardFrontendService.UnchangedPath',
  'NewRpc': 'BardFrontendService.BrandNewEndpoint',
  'NewStr': 'GeminiService.StreamNewStuff',
}));
const SAMPLE_TYPES = new Map(Object.entries({
  'Te6DCf': 'unary',
  'KKERBf': 'unary',
  'MgfGLc': 'unary',
  'ChgRpc': 'server_streaming',
  'TypRpc': 'server_streaming',
  'NewRpc': 'unary',
  'NewStr': 'server_streaming',
}));

async function main() {
  console.log('Posting progress message to Discord...');
  const post = await fetch(WEBHOOK_URL + '?wait=true&with_components=true', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildProgressPayload({
      modulesCompleted: 0, modulesTotal: MODULES_TOTAL,
      chunksExtracted: 0, chunksTotal: 0,
      mappingsFound: 0,
    })),
  });
  if (!post.ok) {
    console.error('Failed to post initial message:', post.status, await post.text());
    process.exit(1);
  }
  const msg = await post.json();
  console.log(`Posted (message ${msg.id}). Watch Discord — progress starts in 3s...`);
  await sleep(3000);

  // Phase 1: module fetch (chunksTotal=0 so payload shows "Fetching modules")
  for (let i = 1; i <= 8; i++) {
    const completed = Math.round((i / 8) * MODULES_TOTAL);
    await patchMessage(WEBHOOK_URL, msg.id, buildProgressPayload({
      modulesCompleted: completed, modulesTotal: MODULES_TOTAL,
      chunksExtracted: 0, chunksTotal: 0,
      mappingsFound: 0,
    }));
    await sleep(2500);
  }

  // Phase 2: extraction (chunksTotal>0 so payload shows "Extracting RPC mappings")
  for (let i = 1; i <= 10; i++) {
    const frac = i / 10;
    await patchMessage(WEBHOOK_URL, msg.id, buildProgressPayload({
      modulesCompleted: MODULES_TOTAL, modulesTotal: MODULES_TOTAL,
      chunksExtracted: Math.round(frac * CHUNKS_TOTAL), chunksTotal: CHUNKS_TOTAL,
      mappingsFound: Math.round(frac * FINAL_MAPPINGS),
    }));
    await sleep(2500);
  }

  // Done: 100%
  await patchMessage(WEBHOOK_URL, msg.id, buildProgressPayload({
    modulesCompleted: MODULES_TOTAL, modulesTotal: MODULES_TOTAL,
    chunksExtracted: CHUNKS_TOTAL, chunksTotal: CHUNKS_TOTAL,
    mappingsFound: FINAL_MAPPINGS,
  }));
  console.log('Scan simulated complete. Showing sample diff report...');
  await sleep(2500);

  // Final: replace progress with the sample diff report
  const report = buildReport(SAMPLE_PREV, SAMPLE_CURRENT, SAMPLE_TYPES);
  await patchMessage(WEBHOOK_URL, msg.id, report);
  console.log('Demo complete — the message now shows the sample diff report.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
