import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import {
  ASYNC_ANALYSIS_DEFAULTS,
  AsyncAnalysisStack,
} from '../lib/async-analysis-stack';

describe('AsyncAnalysisStack', () => {
  const createTemplate = (options?: {
    asyncAnalysisEnabled?: boolean;
    workerEnabled?: boolean;
  }): Template => {
    const app = new App();
    const stack = new AsyncAnalysisStack(app, 'TestStack', {
      env: { account: '111111111111', region: 'ap-northeast-2' },
      stageName: 'production',
      ...options,
    });
    return Template.fromStack(stack);
  };

  it('creates an encrypted FIFO queue and retained FIFO DLQ', () => {
    const template = createTemplate();

    template.resourceCountIs('AWS::SQS::Queue', 2);
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'git-mate-production-analysis.fifo',
      FifoQueue: true,
      ContentBasedDeduplication: false,
      SqsManagedSseEnabled: true,
      MessageRetentionPeriod: 345600,
      VisibilityTimeout: ASYNC_ANALYSIS_DEFAULTS.queueVisibilityTimeoutSeconds,
      RedrivePolicy: {
        maxReceiveCount: ASYNC_ANALYSIS_DEFAULTS.maxReceiveCount,
        deadLetterTargetArn: Match.anyValue(),
      },
    });
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'git-mate-production-analysis-dlq.fifo',
      FifoQueue: true,
      SqsManagedSseEnabled: true,
      MessageRetentionPeriod: 1209600,
    });
  });

  it('uses the required worker timeout, concurrency, and single-record batches', () => {
    const template = createTemplate();

    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'git-mate-production-analysis-worker',
      Timeout: ASYNC_ANALYSIS_DEFAULTS.workerTimeoutSeconds,
      ReservedConcurrentExecutions:
        ASYNC_ANALYSIS_DEFAULTS.workerReservedConcurrency,
      TracingConfig: { Mode: 'Active' },
    });
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: ASYNC_ANALYSIS_DEFAULTS.workerBatchSize,
      Enabled: true,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      ScalingConfig: {
        MaximumConcurrency: ASYNC_ANALYSIS_DEFAULTS.workerReservedConcurrency,
      },
    });
  });

  it('provisions API, Worker, and Reconciler with X-Ray and activates async API', () => {
    const template = createTemplate();
    const functions = template.findResources('AWS::Lambda::Function');

    expect(Object.keys(functions)).toHaveLength(3);
    for (const resource of Object.values(functions)) {
      expect(resource.Properties).toMatchObject({
        PackageType: 'Image',
        TracingConfig: { Mode: 'Active' },
        LoggingConfig: { LogFormat: 'JSON' },
        Environment: {
          Variables: {
            ASYNC_ANALYSIS_ENABLED: 'true',
          },
        },
      });
    }
    template.hasResourceProperties('AWS::Lambda::Url', {
      AuthType: 'NONE',
      InvokeMode: 'BUFFERED',
    });
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(1 minute)',
      State: 'ENABLED',
    });
  });

  it('can disable new async requests and queue consumption for rollback', () => {
    const template = createTemplate({
      asyncAnalysisEnabled: false,
      workerEnabled: false,
    });

    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'git-mate-production-api',
      Environment: {
        Variables: Match.objectLike({ ASYNC_ANALYSIS_ENABLED: 'false' }),
      },
    });
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      Enabled: false,
    });
  });

  it('keeps secret values in Secrets Manager dynamic references', () => {
    const template = createTemplate();
    const rendered = JSON.stringify(template.toJSON());

    template.hasParameter('RuntimeSecretArn', { NoEcho: true });
    expect(rendered).toContain('{{resolve:secretsmanager:');
    expect(rendered).not.toContain('sk-');
    expect(rendered).not.toContain('BEGIN PRIVATE KEY');
    expect(rendered).not.toContain('secretsmanager:GetSecretValue');
  });

  it('scopes SQS permissions to each Lambda responsibility', () => {
    const template = createTemplate();
    const policies = Object.values(
      template.findResources('AWS::IAM::Policy'),
    ) as IamPolicyResource[];
    const policyForRole = (logicalRoleId: string) =>
      policies.find((resource) =>
        JSON.stringify(resource.Properties.Roles).includes(logicalRoleId),
      );
    const sqsActions = (policy: IamPolicyResource | undefined): string[] => {
      if (!policy) {
        throw new Error('Expected IAM policy was not synthesized.');
      }
      return policy.Properties.PolicyDocument.Statement.flatMap((statement) =>
        Array.isArray(statement.Action) ? statement.Action : [statement.Action],
      ).filter((action) => action.startsWith('sqs:'));
    };

    const apiPolicy = policyForRole('ApiRole');
    const workerPolicy = policyForRole('WorkerRole');
    const reconcilerPolicy = policyForRole('ReconcilerRole');

    expect(sqsActions(apiPolicy)).toEqual(
      expect.arrayContaining(['sqs:SendMessage']),
    );
    expect(sqsActions(apiPolicy)).not.toEqual(
      expect.arrayContaining(['sqs:ReceiveMessage', 'sqs:DeleteMessage']),
    );
    expect(sqsActions(workerPolicy)).toEqual(
      expect.arrayContaining(['sqs:ReceiveMessage', 'sqs:DeleteMessage']),
    );
    expect(sqsActions(workerPolicy)).not.toContain('sqs:SendMessage');
    expect(sqsActions(reconcilerPolicy)).toEqual(
      expect.arrayContaining(['sqs:SendMessage']),
    );

    for (const policy of policies) {
      expect(JSON.stringify(policy)).not.toContain('"sqs:*"');
      expect(JSON.stringify(policy)).not.toContain('"Action":"*"');
    }
  });

  it('creates retained logs, operational metrics, dashboard, and alarms', () => {
    const template = createTemplate();
    const logGroups = Object.values(
      template.findResources('AWS::Logs::LogGroup'),
    ) as Array<{
      Properties: { RetentionInDays: number };
      DeletionPolicy: string;
      UpdateReplacePolicy: string;
    }>;

    template.resourceCountIs('AWS::Logs::LogGroup', 3);
    template.resourceCountIs('AWS::Logs::MetricFilter', 2);
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    template.resourceCountIs('AWS::CloudWatch::Alarm', 8);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'git-mate-production-analysis-dlq-not-empty',
      Threshold: ASYNC_ANALYSIS_DEFAULTS.dlqAlarmThreshold,
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'git-mate-production-analysis-queue-age',
      Threshold: ASYNC_ANALYSIS_DEFAULTS.queueAgeAlarmSeconds,
    });
    for (const logGroup of logGroups) {
      expect(logGroup.Properties.RetentionInDays).toBe(30);
      expect(logGroup.DeletionPolicy).toBe('Retain');
      expect(logGroup.UpdateReplacePolicy).toBe('Retain');
    }
  });
});

interface IamPolicyResource {
  Properties: {
    Roles: unknown;
    PolicyDocument: {
      Statement: Array<{ Action: string | string[] }>;
    };
  };
}
