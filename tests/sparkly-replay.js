import { readFileSync } from 'node:fs';
import { analyzeSparklyReview } from '../src/sparkly.js';

const cases = JSON.parse(readFileSync(new URL('./fixtures/sparkly-history.json', import.meta.url), 'utf8'));
let failures = 0;
let important = 0;
let routine = 0;

for (const fixture of cases) {
  try {
    const verdict = await analyzeSparklyReview(fixture);
    if (verdict.important) important++;
    else routine++;
    console.log(JSON.stringify({ revision: fixture.revision, tracker: fixture.tracker, ...verdict }));
  } catch {
    failures++;
    console.error(`Sparkly review failed for ${fixture.tracker} at ${fixture.revision}`);
  }
}

console.log(`Sparkly replay: ${cases.length} cases, ${important} important, ${routine} routine, ${failures} failed`);
if (failures) process.exitCode = 1;
