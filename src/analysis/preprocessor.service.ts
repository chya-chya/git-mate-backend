import { Injectable } from '@nestjs/common';
import { CollectedDataDto } from '../collection/types/github-api.types';

@Injectable()
export class PreprocessorService {
  /**
   * Clean text and mask sensitive information
   */
  preprocess(data: CollectedDataDto): CollectedDataDto {
    return {
      ...data,
      pullRequests: data.pullRequests.map((pr) => ({
        ...pr,
        body: this.cleanText(pr.body),
        reviews: pr.reviews.map((review) => ({
          ...review,
          body: this.cleanText(review.body),
          comments: review.comments.map((comment) => ({
            ...comment,
            body: this.cleanText(comment.body),
          })),
        })),
      })),
    };
  }

  private cleanText(text: string): string {
    if (!text) return '';

    let cleaned = text
      // 1. Remove Markdown images: ![]()
      .replace(/!\[.*?\]\(.*?\)/g, '')
      // 2. Remove HTML tags
      .replace(/<[^>]*>?/gm, '')
      // 3. Truncate long code blocks (keep first 50 lines)
      .split('```')
      .map((part, index) => {
        if (index % 2 === 1) {
          // Inside code block
          const lines = part.split('\n');
          if (lines.length > 50) {
            return (
              lines.slice(0, 50).join('\n') + '\n... (truncated for analysis)'
            );
          }
        }
        return part;
      })
      .join('```');

    // 4. Basic Anonymization (Masking emails/keys)
    cleaned = cleaned
      .replace(/[\w\.-]+@[\w\.-]+\.\w{2,4}/g, '***@***.***') // Email
      .replace(
        /(xox[p|b|o|r]-[0-9]{12}-[0-9]{12}-[0-9]{12}-[a-z0-9]{32})/gi,
        '[REDACTED_API_KEY]',
      ); // Slack-like key example

    return cleaned.trim();
  }
}
