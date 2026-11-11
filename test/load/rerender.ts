/**
 * `bun test/load/rerender.ts <results dir>`: rebuilds `summary.md` (and the `distributed` capacity) of a
 * finished run from its saved `<scenario>.json` files, without running any load. Used when the analysis
 * or the rendering changes after a run. The environment header comes from `environment.json`, or, for
 * runs that predate that file, from the existing `summary.md`.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { capacityOf } from './support/analysis';
import { renderEnvironment, renderSummary, type Environment, type ScenarioResult } from './support/report';

const SCENARIO_ORDER = ['distributed', 'hot-wallet', 'duplicates', 'sqs-drain', 'soak'];

const dir = process.argv[2];
if (!dir) throw new Error('usage: bun test/load/rerender.ts <results dir>');

const results: ScenarioResult[] = [];
for (const name of SCENARIO_ORDER) {
  const file = Bun.file(join(dir, `${name}.json`));
  if (!(await file.exists())) continue;
  const result = (await file.json()) as ScenarioResult;
  if (name === 'distributed') {
    const levels = String(result.config.LEVELS).split(',').map(Number);
    result.capacity = capacityOf(result.slices, levels);
    await Bun.write(file, JSON.stringify(result, null, 2));
  }
  results.push(result);
}

const envFile = Bun.file(join(dir, 'environment.json'));
let header: string[];
if (await envFile.exists()) header = renderEnvironment((await envFile.json()) as Environment);
else {
  const old = (await readdir(dir)).includes('summary.md') ? await Bun.file(join(dir, 'summary.md')).text() : '';
  header = old.split('\n').filter((line) => /^- (Host:|Docker |k6:)/.test(line));
}

await Bun.write(join(dir, 'summary.md'), renderSummary(header, results));
console.log(`rerendered ${join(dir, 'summary.md')} (${results.map((r) => r.name).join(', ')})`);
