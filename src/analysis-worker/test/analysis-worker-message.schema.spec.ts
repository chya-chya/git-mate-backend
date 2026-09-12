import { parseAnalysisWorkerMessage } from '../analysis-worker-message.schema';

describe('parseAnalysisWorkerMessage', () => {
  const jobId = '8fe6a55c-956a-4d8f-985f-fcf2bc72e34c';

  it('parses the strict version-one contract', () => {
    expect(
      parseAnalysisWorkerMessage(JSON.stringify({ schemaVersion: 1, jobId })),
    ).toEqual({ kind: 'VALID', message: { schemaVersion: 1, jobId } });
  });

  it.each([
    ['invalid JSON', '{'],
    ['a primitive', 'null'],
    ['an extra field', JSON.stringify({ schemaVersion: 1, jobId, userId: 7 })],
    [
      'an uppercase UUID',
      JSON.stringify({ schemaVersion: 1, jobId: jobId.toUpperCase() }),
    ],
  ])('rejects %s', (_description, body) => {
    expect(parseAnalysisWorkerMessage(body).kind).toBe('INVALID');
  });

  it('retains a valid Job ID from an unsupported version for safe terminalization', () => {
    expect(
      parseAnalysisWorkerMessage(JSON.stringify({ schemaVersion: 2, jobId })),
    ).toEqual({ kind: 'INVALID', jobId });
  });
});
