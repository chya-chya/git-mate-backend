import {
  ConflictException,
  ExecutionContext,
  INestApplication,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AnalysisJobStage, AnalysisJobStatus } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AnalysisJobApiRepository } from '../src/analysis-job/analysis-job-api.repository';
import { AnalysisJobApiService } from '../src/analysis-job/analysis-job-api.service';
import { AnalysisJobController } from '../src/analysis-job/analysis-job.controller';
import { AnalysisJobValidationExceptionFilter } from '../src/analysis-job/filters/analysis-job-validation-exception.filter';
import { AnalysisJobJwtAuthGuard } from '../src/analysis-job/guards/analysis-job-jwt-auth.guard';
import { AnalysisJobRateLimitGuard } from '../src/analysis-job/guards/analysis-job-rate-limit.guard';
import { AsyncAnalysisEnabledGuard } from '../src/analysis-job/guards/async-analysis-enabled.guard';
import { AnalysisJobUuidPipe } from '../src/analysis-job/pipes/analysis-job-uuid.pipe';
import { IdempotencyKeyPipe } from '../src/analysis-job/pipes/idempotency-key.pipe';

const JOB_ID = '11111111-1111-4111-8111-111111111111';

interface TestAuthenticatedRequest {
  user?: { id: number };
}

function expectResponseCode(response: request.Response, code: string): void {
  const body: unknown = response.body;
  if (typeof body !== 'object' || body === null) {
    throw new Error('Expected a structured response body');
  }
  expect((body as Record<string, unknown>).code).toBe(code);
}

function createJobResponse(
  status: AnalysisJobStatus = AnalysisJobStatus.QUEUED,
) {
  return {
    jobId: JOB_ID,
    status,
    stage:
      status === AnalysisJobStatus.QUEUED ? AnalysisJobStage.WAITING : null,
    progress: status === AnalysisJobStatus.SUCCEEDED ? 100 : 0,
    attempt: 0,
    repository: {
      id: 17,
      githubRepoId: '12345678901234567890',
      fullName: 'octocat/example',
    },
    tokens: { estimated: null, reserved: null, consumed: null },
    result: null,
    error: null,
    createdAt: '2026-08-16T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    updatedAt: '2026-08-16T00:00:00.000Z',
    links: { self: `/analysis/jobs/${JOB_ID}` },
  };
}

describe('Analysis Job API (e2e)', () => {
  let app: INestApplication<App>;
  let authenticated = true;
  let enabled = true;
  let userId = 7;
  const service = {
    create: jest.fn().mockResolvedValue(createJobResponse()),
    retry: jest.fn().mockResolvedValue(createJobResponse()),
    findOne: jest.fn().mockResolvedValue(createJobResponse()),
    list: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
  };

  beforeEach(async () => {
    authenticated = true;
    enabled = true;
    userId = 7;
    jest.clearAllMocks();

    const moduleBuilder = Test.createTestingModule({
      controllers: [AnalysisJobController],
      providers: [
        { provide: AnalysisJobApiService, useValue: service },
        IdempotencyKeyPipe,
        AnalysisJobUuidPipe,
        AnalysisJobValidationExceptionFilter,
        AnalysisJobJwtAuthGuard,
        AsyncAnalysisEnabledGuard,
        AnalysisJobRateLimitGuard,
        { provide: ConfigService, useValue: { get: jest.fn() } },
        {
          provide: AnalysisJobApiRepository,
          useValue: { getCreationRateLimitStatus: jest.fn() },
        },
      ],
    })
      .overrideGuard(AnalysisJobJwtAuthGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          if (!authenticated) {
            throw new UnauthorizedException({
              code: 'UNAUTHORIZED',
              message: 'Authentication is required.',
            });
          }
          context.switchToHttp().getRequest<TestAuthenticatedRequest>().user = {
            id: userId,
          };
          return true;
        },
      })
      .overrideGuard(AsyncAnalysisEnabledGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          expect(
            context.switchToHttp().getRequest<TestAuthenticatedRequest>().user,
          ).toEqual({ id: userId });
          if (!enabled) {
            throw new ServiceUnavailableException({
              code: 'ASYNC_ANALYSIS_DISABLED',
              message: 'Asynchronous analysis is disabled.',
            });
          }
          return true;
        },
      })
      .overrideGuard(AnalysisJobRateLimitGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          expect(
            context.switchToHttp().getRequest<TestAuthenticatedRequest>().user,
          ).toEqual({ id: userId });
          return true;
        },
      });

    const moduleFixture = await moduleBuilder.compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(() => app?.close());

  it('returns 202 with polling headers for a newly accepted Job', async () => {
    await request(app.getHttpServer())
      .post('/analysis/jobs')
      .set('Idempotency-Key', 'request-1')
      .send({ githubRepoId: '12345678901234567890' })
      .expect(202)
      .expect('Location', `/analysis/jobs/${JOB_ID}`)
      .expect('Retry-After', '2')
      .expect(({ body }) => {
        expect(body).toMatchObject({ jobId: JOB_ID, status: 'QUEUED' });
      });

    expect(service.create).toHaveBeenCalledWith(
      7,
      '12345678901234567890',
      'request-1',
    );
  });

  it('rejects missing authentication before the feature and rate guards', async () => {
    authenticated = false;

    await request(app.getHttpServer())
      .get(`/analysis/jobs/${JOB_ID}`)
      .expect(401)
      .expect((response) => expectResponseCode(response, 'UNAUTHORIZED'));
  });

  it('fails closed with no storage mutation when the feature is disabled', async () => {
    enabled = false;

    await request(app.getHttpServer())
      .post('/analysis/jobs')
      .set('Idempotency-Key', 'request-1')
      .send({ githubRepoId: '123456789' })
      .expect(503)
      .expect((response) =>
        expectResponseCode(response, 'ASYNC_ANALYSIS_DISABLED'),
      );

    expect(service.create).not.toHaveBeenCalled();
  });

  it.each([
    [{ githubRepoId: 123 }, 'request-1'],
    [{ githubRepoId: '0' }, 'request-1'],
    [{ githubRepoId: '123', extra: true }, 'request-1'],
    [{ githubRepoId: '123' }, 'legacy-report:1'],
  ])('rejects an invalid body or idempotency key', async (body, key) => {
    await request(app.getHttpServer())
      .post('/analysis/jobs')
      .set('Idempotency-Key', key)
      .send(body)
      .expect(400)
      .expect((response) => expectResponseCode(response, 'INVALID_REQUEST'));
    expect(service.create).not.toHaveBeenCalled();
  });

  it('strictly validates list query values', async () => {
    await request(app.getHttpServer())
      .get('/analysis/jobs?limit=101&status=UNKNOWN&extra=true')
      .expect(400)
      .expect((response) => expectResponseCode(response, 'INVALID_REQUEST'));
    expect(service.list).not.toHaveBeenCalled();
  });

  it('rejects repository IDs above the PostgreSQL integer range', async () => {
    await request(app.getHttpServer())
      .get('/analysis/jobs?repositoryId=2147483648')
      .expect(400)
      .expect((response) => expectResponseCode(response, 'INVALID_REQUEST'));
    expect(service.list).not.toHaveBeenCalled();
  });

  it('rejects malformed UUID parameters', async () => {
    await request(app.getHttpServer())
      .get('/analysis/jobs/not-a-uuid')
      .expect(400)
      .expect((response) => expectResponseCode(response, 'INVALID_REQUEST'));
    expect(service.findOne).not.toHaveBeenCalled();
  });

  it('normalizes uppercase UUID parameters before querying a Job', async () => {
    await request(app.getHttpServer())
      .get('/analysis/jobs/ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF')
      .expect(200);

    expect(service.findOne).toHaveBeenCalledWith(
      7,
      'abcdefab-cdef-4abc-8def-abcdefabcdef',
    );
  });

  it('returns 404 for a Job that is absent or belongs to another user', async () => {
    service.findOne.mockRejectedValueOnce(
      new NotFoundException({
        code: 'JOB_NOT_FOUND',
        message: 'Analysis job was not found.',
      }),
    );

    await request(app.getHttpServer())
      .get(`/analysis/jobs/${JOB_ID}`)
      .expect(404)
      .expect((response) => expectResponseCode(response, 'JOB_NOT_FOUND'));
  });

  it('returns 409 for a Job that cannot be retried', async () => {
    service.retry.mockRejectedValueOnce(
      new ConflictException({
        code: 'JOB_NOT_RETRYABLE',
        message: 'Analysis job cannot be retried.',
      }),
    );

    await request(app.getHttpServer())
      .post(`/analysis/jobs/${JOB_ID}/retry`)
      .set('Idempotency-Key', 'retry-1')
      .expect(409)
      .expect((response) => expectResponseCode(response, 'JOB_NOT_RETRYABLE'));
  });

  it('documents all four endpoints and their contracts in Swagger', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
    );

    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        '/analysis/jobs',
        '/analysis/jobs/{id}',
        '/analysis/jobs/{id}/retry',
      ]),
    );
    const responses = document.paths['/analysis/jobs']?.post?.responses;
    for (const status of ['202', '400', '401', '404', '409', '429', '503']) {
      expect(responses).toHaveProperty(status);
    }
    const repositoryIdParameter = document.paths[
      '/analysis/jobs'
    ]?.get?.parameters?.find(
      (parameter) => 'name' in parameter && parameter.name === 'repositoryId',
    );
    expect(repositoryIdParameter).toMatchObject({
      schema: { maximum: 2147483647 },
    });
    const schemas = document.components?.schemas;
    expect(schemas).toHaveProperty('AnalysisJobResponseDto');
    expect(schemas).toHaveProperty('AnalysisJobListResponseDto');
    expect(schemas).toHaveProperty('AnalysisJobApiErrorDto');
  });
});
