import { CollectedDataDto } from '../collection/types/github-api.types';
import {
  ANALYSIS_METRIC_KEYS,
  AnalysisEvidenceRelation,
  AnalysisEvidenceSourceType,
  AnalysisMetricKey,
  LlmAnalysisPayload,
} from './analysis-result.schema';

export type EvidenceValidationIssueCode =
  | 'UNKNOWN_PR'
  | 'PERMALINK_MISMATCH'
  | 'AUTHOR_MISMATCH'
  | 'SOURCE_RELATION_MISMATCH'
  | 'QUOTE_NOT_OWNED'
  | 'UNSUPPORTED_SCORE_WITHOUT_EVIDENCE'
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
  /(?:(?:https?:\/\/)?(?:www\.)?github\.com(?:\/[^\s)]*)?|\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+\b|(?<![\p{L}\p{N}_])#\d+\b|\b(?:PR|pull request)\s*#?\d+\b|\d+\s*번\s*(?:PR|pull request)(?![A-Za-z0-9_]))/iu;

export function validateAnalysisEvidence(
  result: LlmAnalysisPayload,
  data: CollectedDataDto,
): readonly EvidenceValidationIssue[] {
  const issues: EvidenceValidationIssue[] = [];
  const targetUser = data.targetUser.toLocaleLowerCase('en-US');
  const pullRequests = new Map(data.pullRequests.map((pr) => [pr.number, pr]));

  for (const metric of ANALYSIS_METRIC_KEYS) {
    const evaluation = result[metric];
    if (
      evaluation.evidence.length === 0 &&
      evaluation.score !== 3 &&
      evaluation.score !== 3.5
    ) {
      issues.push({
        code: 'UNSUPPORTED_SCORE_WITHOUT_EVIDENCE',
        metric,
        evidenceIndex: null,
      });
    }
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

      const expectedRelation = RELATION_BY_SOURCE_TYPE[evidence.sourceType];
      if (evidence.targetRelation !== expectedRelation) {
        issues.push({
          code: 'SOURCE_RELATION_MISMATCH',
          metric,
          evidenceIndex,
        });
        return;
      }

      const ownedActivities = collectOwnedActivities(pullRequest, targetUser);
      const normalizedQuote = normalizeEvidenceText(evidence.quote);
      if (
        normalizedQuote.length === 0 ||
        !ownedActivities.some(
          (activity) =>
            activity.sourceType === evidence.sourceType &&
            activity.targetRelation === evidence.targetRelation &&
            normalizeEvidenceText(activity.text).includes(normalizedQuote),
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
  result: LlmAnalysisPayload,
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
): OwnedActivity[] {
  const activities: OwnedActivity[] = [];
  if (pullRequest.author.toLocaleLowerCase('en-US') === targetUser) {
    activities.push(
      {
        sourceType: 'pull_request',
        targetRelation: 'target_authored_pr',
        text: pullRequest.title,
      },
      {
        sourceType: 'pull_request',
        targetRelation: 'target_authored_pr',
        text: pullRequest.body,
      },
    );
  }
  for (const review of pullRequest.reviews) {
    if (review.author.toLocaleLowerCase('en-US') === targetUser) {
      activities.push({
        sourceType: 'review',
        targetRelation: 'target_authored_review',
        text: review.body,
      });
    }
    for (const comment of review.comments) {
      if (comment.author.toLocaleLowerCase('en-US') === targetUser) {
        activities.push({
          sourceType: 'review_comment',
          targetRelation: 'target_authored_review_comment',
          text: comment.body,
        });
      }
    }
  }
  return activities;
}

const RELATION_BY_SOURCE_TYPE: Record<
  AnalysisEvidenceSourceType,
  AnalysisEvidenceRelation
> = {
  pull_request: 'target_authored_pr',
  review: 'target_authored_review',
  review_comment: 'target_authored_review_comment',
};

interface OwnedActivity {
  sourceType: AnalysisEvidenceSourceType;
  targetRelation: AnalysisEvidenceRelation;
  text: string;
}
