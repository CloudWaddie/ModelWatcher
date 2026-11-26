import { readFileSync } from 'node:fs';
import { analyzeSparklyReview } from '../src/sparkly.js';

const revision = process.env.SPARKLY_REPLAY_REVISION;
const fixturePath = revision ? './fixtures/sparkly-captured.json' : './fixtures/sparkly-history.json';
const fixtures = JSON.parse(readFileSync(new URL(fixturePath, import.meta.url), 'utf8'));
const cases = revision ? fixtures.filter(fixture => fixture.revision === revision) : fixtures;
if (!cases.length) throw new Error('No matching Sparkly replay fixture');
let failures = 0;
const priorities = { high: 0, medium: 0, routine: 0 };
let skipped = 0;

for (const fixture of cases) {
  try {
    const verdict = await analyzeSparklyReview(fixture, message => {
      console.log(`[Sparkly ${fixture.revision}] ${message}`);
    });
    if (!verdict) {
      skipped++;
      console.log(JSON.stringify({ revision: fixture.revision, tracker: fixture.tracker, skipped: true }));
      continue;
    }
    priorities[verdict.priority]++;
    console.log(JSON.stringify({ revision: fixture.revision, tracker: fixture.tracker, ...verdict }));
  } catch (error) {
    failures++;
    const type = ['TimeoutError', 'SyntaxError', 'TypeError'].includes(error?.name) ? error.name : 'Error';
    console.error(`Sparkly review failed for ${fixture.tracker} at ${fixture.revision} (${type})`);
  }
}

console.log(`Sparkly replay: ${cases.length} cases, ${priorities.high} high, ${priorities.medium} medium, ${priorities.routine} routine, ${skipped} skipped, ${failures} failed`);
if (failures) process.exitCode = 1;
