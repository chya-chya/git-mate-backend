import { Injectable } from '@nestjs/common';
import {
  CollectedDataDto,
  PullRequestDto,
} from '../collection/types/github-api.types';

@Injectable()
export class RefinerService {
  /**
   * Filter out noise and group comments by thread context
   */
  refine(data: CollectedDataDto): CollectedDataDto {
    const refinedPRs = data.pullRequests
      .map((pr) => {
        const filteredReviews = pr.reviews
          .filter((review) => {
            // 1. Filter out simple greetings or short acknowledgments
            const body = review.body.trim();
            if (
              body.length < 5 ||
              /^(LGTM|good|nice|ok|approved|확인|좋습니다)/i.test(body)
            ) {
              return false;
            }
            return true;
          })
          .map((review) => ({
            ...review,
            comments: review.comments.filter((comment) => {
              // Filter bot comments or very short ones
              return comment.body.trim().length >= 5;
            }),
          }));

        return {
          ...pr,
          reviews: filteredReviews,
        };
      })
      .filter((pr) => pr.reviews.length > 0); // Keep only PRs with meaningful reviews

    return {
      ...data,
      pullRequests: refinedPRs,
    };
  }
}
