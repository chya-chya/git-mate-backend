import { assertLiveEvalOptIn } from '../evals/live-eval';

describe('live analysis evaluation guard', () => {
  it.each([
    [{}, 'Live evaluation is disabled'],
    [{ RUN_LIVE_OPENAI_EVALS: 'false', OPENAI_API_KEY: 'secret' }, 'disabled'],
    [{ RUN_LIVE_OPENAI_EVALS: 'true' }, 'OPENAI_API_KEY'],
  ])('rejects missing double opt-in', (environment, message) => {
    expect(() => assertLiveEvalOptIn(environment, false)).toThrow(message);
  });

  it('allows explicit opt-in and key without exposing or changing the model', () => {
    expect(() =>
      assertLiveEvalOptIn(
        { RUN_LIVE_OPENAI_EVALS: 'true', OPENAI_API_KEY: 'secret' },
        false,
      ),
    ).not.toThrow();
  });

  it('allows a zero-call dry run without credentials', () => {
    expect(() => assertLiveEvalOptIn({}, true)).not.toThrow();
  });
});
