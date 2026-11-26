import { readFileSync } from 'node:fs';
import { analyzeSparklyReview } from '../src/sparkly.js';

const cases = JSON.parse(readFileSync(new URL('./fixtures/sparkly-history.json', import.meta.url), 'utf8'));
let failures = 0;
const priorities = { high: 0, medium: 0, routine: 0 };
let skipped = 0;

for (const fixture of cases) {
  try {
    const verdict = await analyzeSparklyReview(fixture);
    if (!verdict) {
      skipped++;
      console.log(JSON.stringify({ revision: fixture.revision, tracker: fixture.tracker, skipped: true }));
      continue;
    }
    priorities[verdict.priority]++;
    console.log(JSON.stringify({ revision: fixture.revision, tracker: fixture.tracker, ...verdict }));
  } catch {
    failures++;
    console.error(`Sparkly review failed for ${fixture.tracker} at ${fixture.revision}`);
  }
}

console.log(`Sparkly replay: ${cases.length} cases, ${priorities.high} high, ${priorities.medium} medium, ${priorities.routine} routine, ${skipped} skipped, ${failures} failed`);
if (failures) process.exitCode = 1;
