import {
  isValidAnalysisTokenUsage,
  isValidProviderRequestId,
} from '../analysis-billing-metadata';

describe('analysis billing metadata', () => {
  it('accepts non-negative token counts with a matching total', () => {
    expect(
      isValidAnalysisTokenUsage({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      }),
    ).toBe(true);
  });

  it.each([
    { promptTokens: -1, completionTokens: 5, totalTokens: 4 },
    { promptTokens: 10, completionTokens: 5, totalTokens: 14 },
    { promptTokens: 10.5, completionTokens: 5, totalTokens: 15.5 },
    {
      promptTokens: Number.MAX_SAFE_INTEGER,
      completionTokens: 1,
      totalTokens: Number.MAX_SAFE_INTEGER + 1,
    },
  ])('rejects invalid token usage %#', (usage) => {
    expect(isValidAnalysisTokenUsage(usage)).toBe(false);
  });

  it('accepts only bounded provider request identifiers', () => {
    expect(isValidProviderRequestId('chatcmpl_request-123')).toBe(true);
    expect(isValidProviderRequestId('contains raw response payload')).toBe(
      false,
    );
    expect(isValidProviderRequestId('a'.repeat(129))).toBe(false);
  });
});
