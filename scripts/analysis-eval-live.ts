import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ANALYSIS_GOLDEN_FIXTURES } from '../src/analysis/evals/golden-fixtures';
import {
  assertLiveEvalOptIn,
  runLiveAnalysisEvaluation,
} from '../src/analysis/evals/live-eval';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const outputIndex = args.indexOf('--output');
const outputPath = resolve(
  outputIndex >= 0 && args[outputIndex + 1]
    ? args[outputIndex + 1]
    : '.artifacts/analysis-evals/latest.json',
);

async function main(): Promise<void> {
  assertLiveEvalOptIn(process.env, dryRun);

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          apiCalls: 0,
          plannedApiCalls: ANALYSIS_GOLDEN_FIXTURES.length,
          outputPath,
        },
        null,
        2,
      ),
    );
    return;
  }

  const report = await runLiveAnalysisEvaluation(process.env);
  try {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    console.log(
      JSON.stringify(
        {
          outputPath,
          callsAttempted: report.callsAttempted,
          passed: report.summary.passed,
        },
        null,
        2,
      ),
    );
    if (!report.summary.passed) {
      process.exitCode = 1;
    }
  } catch (error) {
    throw new Error('Failed to write the live evaluation report.', {
      cause: error,
    });
  }
}

void main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      errorType: error instanceof Error ? error.name : 'UnknownError',
      message:
        error instanceof Error
          ? error.message
          : 'Live evaluation failed unexpectedly.',
    }),
  );
  process.exitCode = 1;
});
