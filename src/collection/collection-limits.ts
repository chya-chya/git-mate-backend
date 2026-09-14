import { PayloadTooLargeException } from '@nestjs/common';

export const COLLECTION_LIMITS = {
  changedPullRequests: 100,
  reviewAndCommentNodes: 2_000,
  analysisInputTokens: 80_000,
} as const;

export type CollectionLimitKind =
  | 'changed pull requests'
  | 'review and comment nodes'
  | 'analysis input tokens';

export class InputLimitExceededError extends PayloadTooLargeException {
  readonly code = 'INPUT_LIMIT_EXCEEDED';

  constructor(
    readonly limitKind: CollectionLimitKind,
    readonly limit: number,
    readonly actual: number,
  ) {
    super({
      code: 'INPUT_LIMIT_EXCEEDED',
      message: `${limitKind} limit exceeded: found ${actual}, maximum ${limit}.`,
    });
    this.name = InputLimitExceededError.name;
  }
}
