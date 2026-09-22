import { CollectedDataDto } from '../collection/types/github-api.types';
import {
  ANALYSIS_METRIC_KEYS,
  AnalysisMetricKey,
  LlmAnalysisResult,
} from './analysis-result.schema';

export type EvidenceValidationIssueCode =
  | 'UNKNOWN_PR'
  | 'PERMALINK_MISMATCH'
  | 'AUTHOR_MISMATCH'
  | 'QUOTE_NOT_OWNED'
  | 'UNSTRUCTURED_REFERENCE';

export interface EvidenceValidationIssue {
  code: EvidenceValidationIssueCode;
  metric: AnalysisMetricKey | 'summary';
  evidenceIndex: number | null;
}

export class InvalidAnalysisEvidenceError extends Error {
  constructor(readonly issues: readonly EvidenceValidationIssue[]) {
    super('The structured analysis evidence is invalid.');
    this.name = InvalidAnalysisEvidenceError.name;
  }
}

const UNSTRUCTURED_REFERENCE_PATTERN =
  /(?:https?:\/\/(?:www\.)?github\.com\/[^\s)]+\/pull\/\d+|\b(?:PR|pull request)\s*#?\d+\b)/i;

export function validateAnalysisEvidence(
  result: LlmAnalysisResult,
  data: CollectedDataDto,
): readonly EvidenceValidationIssue[] {
  const issues: EvidenceValidationIssue[] = [];
  const targetUser = data.targetUser.toLocaleLowerCase('en-US');
  const pullRequests = new Map(data.pullRequests.map((pr) => [pr.number, pr]));

  for (const metric of ANALYSIS_METRIC_KEYS) {
    const evaluation = result[metric];
    for (const narrative of [
      evaluation.reason,
      evaluation.improvement,
      evaluation.example,
    ]) {
      if (UNSTRUCTURED_REFERENCE_PATTERN.test(narrative)) {
        issues.push({
          code: 'UNSTRUCTURED_REFERENCE',
          metric,
          evidenceIndex: null,
        });
        break;
      }
    }

    evaluation.evidence.forEach((evidence, evidenceIndex) => {
      const pullRequest = pullRequests.get(evidence.prNumber);
      if (!pullRequest) {
        issues.push({ code: 'UNKNOWN_PR', metric, evidenceIndex });
        return;
      }
      if (evidence.permalink !== pullRequest.permalink) {
        issues.push({ code: 'PERMALINK_MISMATCH', metric, evidenceIndex });
      }
      if (evidence.author.toLocaleLowerCase('en-US') !== targetUser) {
        issues.push({ code: 'AUTHOR_MISMATCH', metric, evidenceIndex });
        return;
      }

      const ownedActivities = collectOwnedActivities(pullRequest, targetUser);
      const normalizedQuote = normalizeEvidenceText(evidence.quote);
      if (
        normalizedQuote.length === 0 ||
        !ownedActivities.some((activity) =>
          normalizeEvidenceText(activity).includes(normalizedQuote),
        )
      ) {
        issues.push({ code: 'QUOTE_NOT_OWNED', metric, evidenceIndex });
      }
    });
  }

  if (UNSTRUCTURED_REFERENCE_PATTERN.test(result.summary)) {
    issues.push({
      code: 'UNSTRUCTURED_REFERENCE',
      metric: 'summary',
      evidenceIndex: null,
    });
  }

  return issues;
}

export function assertValidAnalysisEvidence(
  result: LlmAnalysisResult,
  data: CollectedDataDto,
): void {
  const issues = validateAnalysisEvidence(result, data);
  if (issues.length > 0) {
    throw new InvalidAnalysisEvidenceError(issues);
  }
}

export function normalizeEvidenceText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
}

function collectOwnedActivities(
  pullRequest: CollectedDataDto['pullRequests'][number],
  targetUser: string,
): string[] {
  const activities: string[] = [];
  if (pullRequest.author.toLocaleLowerCase('en-US') === targetUser) {
    activities.push(pullRequest.title, pullRequest.body);
  }
  for (const review of pullRequest.reviews) {
    if (review.author.toLocaleLowerCase('en-US') === targetUser) {
      activities.push(review.body);
    }
    for (const comment of review.comments) {
      if (comment.author.toLocaleLowerCase('en-US') === targetUser) {
        activities.push(comment.body);
      }
    }
  }
  return activities;
}
