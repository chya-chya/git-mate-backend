import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import {
  assertLiveEvalOptIn,
  createLiveEvalDryRunReport,
  renderLiveEvalMarkdown,
  runLiveAnalysisEvaluation,
} from '../src/analysis/evals/live-eval';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const outputIndex = args.indexOf('--output');
const artifactRoot = resolve('.artifacts/analysis-evals');
const outputPath = resolve(
  outputIndex >= 0 && args[outputIndex + 1]
    ? args[outputIndex + 1]
    : '.artifacts/analysis-evals/latest.json',
);
const markdownPath = outputPath.replace(/\.json$/u, '.md');

async function main(): Promise<void> {
  assertValidArguments();
  assertLiveEvalOptIn(process.env, dryRun);

  if (dryRun) {
    const report = createLiveEvalDryRunReport();
    console.log(
      JSON.stringify(
        {
          ...report,
          outputPath,
          markdownPath,
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
    writeFileSync(markdownPath, renderLiveEvalMarkdown(report), {
      encoding: 'utf8',
      mode: 0o600,
    });
    console.log(
      JSON.stringify(
        {
          outputPath,
          markdownPath,
          callsAttempted: report.callsAttempted,
          passed: report.comparison.passed,
        },
        null,
        2,
      ),
    );
    if (!report.comparison.passed) {
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
      message: 'Live evaluation failed. Review configuration and local logs.',
    }),
  );
  process.exitCode = 1;
});

function assertValidArguments(): void {
  const knownArguments = new Set(['--dry-run', '--output']);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--output') {
      index += 1;
      if (!args[index]) {
        throw new Error('--output requires a JSON path.');
      }
      continue;
    }
    if (!knownArguments.has(argument)) {
      throw new Error(`Unknown live evaluation argument: ${argument}`);
    }
  }
  const relativeOutput = relative(artifactRoot, outputPath);
  if (
    relativeOutput.startsWith('..') ||
    relativeOutput === '' ||
    extname(outputPath) !== '.json'
  ) {
    throw new Error(
      'Live evaluation output must be a JSON file under .artifacts/analysis-evals.',
    );
  }
}
