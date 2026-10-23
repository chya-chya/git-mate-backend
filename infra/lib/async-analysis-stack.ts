import * as path from 'node:path';
import {
  CfnCondition,
  CfnOutput,
  CfnParameter,
  Duration,
  Fn,
  IgnoreMode,
  RemovalPolicy,
  SecretValue,
  Stack,
  StackProps,
  Tags,
} from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export const ASYNC_ANALYSIS_DEFAULTS = Object.freeze({
  apiTimeoutSeconds: 300,
  apiReservedConcurrency: 10,
  workerBatchSize: 1,
  workerTimeoutSeconds: 300,
  queueVisibilityTimeoutSeconds: 1800,
  workerReservedConcurrency: 3,
  maxReceiveCount: 5,
  dlqAlarmThreshold: 1,
  queueAgeAlarmSeconds: 600,
});

export interface AsyncAnalysisStackProps extends StackProps {
  stageName?: string;
  asyncAnalysisEnabled?: boolean;
  workerEnabled?: boolean;
}

export class AsyncAnalysisStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: AsyncAnalysisStackProps = {},
  ) {
    super(scope, id, props);

    const stageName = validateStageName(props.stageName ?? 'production');
    const resourcePrefix = `git-mate-${stageName}`;
    const repositoryRoot = path.resolve(__dirname, '../..');
    const dockerAssetOptions = {
      exclude: [
        '.artifacts',
        '.git',
        '.github',
        'cdk.out',
        'coverage',
        'deploy',
        'dist',
        'docs',
        'infra',
        'node_modules',
        'scripts',
        'src/**/test',
        'test',
      ],
      ignoreMode: IgnoreMode.GLOB,
      platform: ecrAssets.Platform.LINUX_AMD64,
    };
    const metricNamespace = `GitMate/AsyncAnalysis/${stageName}`;

    Tags.of(this).add('Service', 'git-mate');
    Tags.of(this).add('Stage', stageName);
    Tags.of(this).add('ManagedBy', 'aws-cdk');

    const runtimeSecretArn = new CfnParameter(this, 'RuntimeSecretArn', {
      type: 'String',
      noEcho: true,
      description:
        'ARN of an existing Secrets Manager JSON secret containing the documented runtime keys.',
      allowedPattern: '^arn:[^:]+:secretsmanager:[^:]+:[0-9]{12}:secret:.+$',
      constraintDescription: 'Must be a complete Secrets Manager secret ARN.',
    });
    const runtimeSecretVersionId = new CfnParameter(
      this,
      'RuntimeSecretVersionId',
      {
        type: 'String',
        noEcho: true,
        description:
          'VersionId currently carrying the AWSCURRENT stage for the runtime secret.',
        allowedPattern: '^[A-Za-z0-9_-]{32,64}$',
        constraintDescription:
          'Must be a 32-64 character Secrets Manager version ID.',
      },
    );
    const frontendUrl = new CfnParameter(this, 'FrontendUrl', {
      type: 'String',
      default: 'https://git-mate-frontend.vercel.app',
      allowedPattern: '^https://.+$',
      constraintDescription: 'Must be an HTTPS URL.',
    });
    const alarmEmail = new CfnParameter(this, 'AlarmEmail', {
      type: 'String',
      default: '',
      allowedPattern: '^$|^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
      constraintDescription: 'Must be empty or a valid email address.',
      description:
        'Optional email address subscribed to the operations alarm topic.',
    });
    const hasAlarmEmail = new CfnCondition(this, 'HasAlarmEmail', {
      expression: Fn.conditionNot(
        Fn.conditionEquals(alarmEmail.valueAsString, ''),
      ),
    });

    const secretValue = (key: string): string =>
      SecretValue.secretsManager(runtimeSecretArn.valueAsString, {
        jsonField: key,
        versionId: runtimeSecretVersionId.valueAsString,
      }).unsafeUnwrap();

    const deadLetterQueue = new sqs.Queue(this, 'AnalysisDeadLetterQueue', {
      queueName: `${resourcePrefix}-analysis-dlq.fifo`,
      fifo: true,
      contentBasedDeduplication: false,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const analysisQueue = new sqs.Queue(this, 'AnalysisQueue', {
      queueName: `${resourcePrefix}-analysis.fifo`,
      fifo: true,
      contentBasedDeduplication: false,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      receiveMessageWaitTime: Duration.seconds(20),
      retentionPeriod: Duration.days(4),
      visibilityTimeout: Duration.seconds(
        ASYNC_ANALYSIS_DEFAULTS.queueVisibilityTimeoutSeconds,
      ),
      deadLetterQueue: {
        queue: deadLetterQueue,
        maxReceiveCount: ASYNC_ANALYSIS_DEFAULTS.maxReceiveCount,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const apiFunctionName = `${resourcePrefix}-api`;
    const workerFunctionName = `${resourcePrefix}-analysis-worker`;
    const reconcilerFunctionName = `${resourcePrefix}-analysis-reconciler`;
    const apiLogGroup = createLogGroup(this, 'ApiLogGroup', apiFunctionName);
    const workerLogGroup = createLogGroup(
      this,
      'WorkerLogGroup',
      workerFunctionName,
    );
    const reconcilerLogGroup = createLogGroup(
      this,
      'ReconcilerLogGroup',
      reconcilerFunctionName,
    );

    const apiRole = createLambdaRole(this, 'ApiRole', apiLogGroup);
    const workerRole = createLambdaRole(this, 'WorkerRole', workerLogGroup);
    const reconcilerRole = createLambdaRole(
      this,
      'ReconcilerRole',
      reconcilerLogGroup,
    );
    analysisQueue.grantSendMessages(apiRole);
    analysisQueue.grantConsumeMessages(workerRole);
    analysisQueue.grantSendMessages(reconcilerRole);

    const commonEnvironment: Record<string, string> = {
      NODE_ENV: 'production',
      NODE_OPTIONS: '--enable-source-maps',
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      AWS_XRAY_CONTEXT_MISSING: 'LOG_ERROR',
      DATABASE_URL: secretValue('DATABASE_URL'),
      DB_POOL_SIZE: '2',
      JWT_SECRET: secretValue('JWT_SECRET'),
      ENCRYPTION_KEY: secretValue('ENCRYPTION_KEY'),
      OPENAI_API_KEY: secretValue('OPENAI_API_KEY'),
      OPENAI_TIMEOUT_MS: '240000',
      GITHUB_CLIENT_ID: secretValue('GITHUB_CLIENT_ID'),
      GITHUB_CLIENT_SECRET: secretValue('GITHUB_CLIENT_SECRET'),
      GITHUB_CALLBACK_URL: secretValue('GITHUB_CALLBACK_URL'),
      GITHUB_APP_ID: secretValue('GITHUB_APP_ID'),
      GITHUB_APP_INSTALL_URL: secretValue('GITHUB_APP_INSTALL_URL'),
      GITHUB_APP_WEBHOOK_SECRET: secretValue('GITHUB_APP_WEBHOOK_SECRET'),
      GITHUB_APP_PRIVATE_KEY: secretValue('GITHUB_APP_PRIVATE_KEY'),
      FRONTEND_URL: frontendUrl.valueAsString,
      ANALYSIS_JOB_QUEUE_URL: analysisQueue.queueUrl,
      ANALYSIS_JOB_PUBLISH_MAX_ATTEMPTS: String(
        ASYNC_ANALYSIS_DEFAULTS.maxReceiveCount,
      ),
      ANALYSIS_JOB_REPUBLISH_AFTER_SECONDS: '60',
      ANALYSIS_JOB_RECONCILE_BATCH_SIZE: '20',
      ANALYSIS_WORKER_LEASE_SECONDS: '900',
      ASYNC_ANALYSIS_ENABLED:
        props.asyncAnalysisEnabled === false ? 'false' : 'true',
    };

    const apiFunction = new lambda.DockerImageFunction(this, 'ApiFunction', {
      functionName: apiFunctionName,
      description: 'Git-Mate HTTP API with asynchronous analysis enabled',
      code: lambda.DockerImageCode.fromImageAsset(repositoryRoot, {
        ...dockerAssetOptions,
        file: 'Dockerfile.lambda',
      }),
      architecture: lambda.Architecture.X86_64,
      timeout: Duration.seconds(ASYNC_ANALYSIS_DEFAULTS.apiTimeoutSeconds),
      memorySize: 1024,
      reservedConcurrentExecutions:
        ASYNC_ANALYSIS_DEFAULTS.apiReservedConcurrency,
      role: apiRole,
      logGroup: apiLogGroup,
      loggingFormat: lambda.LoggingFormat.JSON,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        ...commonEnvironment,
        PORT: '3000',
        AWS_LWA_PORT: '3000',
        AWS_LWA_READINESS_CHECK_PATH: '/',
      },
    });
    const apiUrl = apiFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.BUFFERED,
    });

    const workerFunction = new lambda.DockerImageFunction(
      this,
      'WorkerFunction',
      {
        functionName: workerFunctionName,
        description: 'Processes Git-Mate analysis jobs from SQS FIFO',
        code: lambda.DockerImageCode.fromImageAsset(repositoryRoot, {
          ...dockerAssetOptions,
          file: 'Dockerfile.background',
          cmd: ['dist/src/analysis-worker/analysis-worker.handler.handler'],
        }),
        architecture: lambda.Architecture.X86_64,
        timeout: Duration.seconds(ASYNC_ANALYSIS_DEFAULTS.workerTimeoutSeconds),
        memorySize: 2048,
        reservedConcurrentExecutions:
          ASYNC_ANALYSIS_DEFAULTS.workerReservedConcurrency,
        role: workerRole,
        logGroup: workerLogGroup,
        loggingFormat: lambda.LoggingFormat.JSON,
        tracing: lambda.Tracing.ACTIVE,
        environment: commonEnvironment,
      },
    );
    workerFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(analysisQueue, {
        batchSize: ASYNC_ANALYSIS_DEFAULTS.workerBatchSize,
        enabled: props.workerEnabled !== false,
        maxConcurrency: ASYNC_ANALYSIS_DEFAULTS.workerReservedConcurrency,
        reportBatchItemFailures: true,
      }),
    );

    const reconcilerFunction = new lambda.DockerImageFunction(
      this,
      'ReconcilerFunction',
      {
        functionName: reconcilerFunctionName,
        description: 'Republishes due AnalysisJob outbox records',
        code: lambda.DockerImageCode.fromImageAsset(repositoryRoot, {
          ...dockerAssetOptions,
          file: 'Dockerfile.background',
          cmd: [
            'dist/src/analysis-job/analysis-job-reconciler.handler.handler',
          ],
        }),
        architecture: lambda.Architecture.X86_64,
        timeout: Duration.minutes(2),
        memorySize: 1024,
        reservedConcurrentExecutions: 1,
        role: reconcilerRole,
        logGroup: reconcilerLogGroup,
        loggingFormat: lambda.LoggingFormat.JSON,
        tracing: lambda.Tracing.ACTIVE,
        environment: commonEnvironment,
      },
    );
    const reconcilerSchedule = new events.Rule(this, 'ReconcilerSchedule', {
      ruleName: `${resourcePrefix}-analysis-reconciler`,
      description: 'Runs the AnalysisJob outbox reconciler every minute',
      schedule: events.Schedule.rate(Duration.minutes(1)),
      enabled: props.workerEnabled !== false,
    });
    reconcilerSchedule.addTarget(
      new eventTargets.LambdaFunction(reconcilerFunction, {
        retryAttempts: 0,
      }),
    );

    new logs.MetricFilter(this, 'WorkerFailureMetricFilter', {
      logGroup: workerLogGroup,
      filterPattern: logs.FilterPattern.anyTerm(
        'analysis_worker_job_failed',
        'analysis_worker_bootstrap_failed',
      ),
      metricNamespace,
      metricName: 'WorkerJobFailures',
      metricValue: '1',
      defaultValue: 0,
    });
    new logs.MetricFilter(this, 'ReconcilerFailureMetricFilter', {
      logGroup: reconcilerLogGroup,
      filterPattern: logs.FilterPattern.anyTerm(
        'Analysis job reconciliation item failed',
        'Analysis job reconciliation failed',
        'Analysis job publish acknowledgement was not recorded',
        'Analysis job publish deferred',
        'Analysis job publish failure state was stale',
        'Analysis job reached the publish limit with reserved tokens',
        'Analysis job publish attempt failed',
      ),
      metricNamespace,
      metricName: 'ReconcilerItemFailures',
      metricValue: '1',
      defaultValue: 0,
    });

    const alarmTopic = new sns.Topic(this, 'OperationsAlarmTopic', {
      topicName: `${resourcePrefix}-analysis-alarms`,
      displayName: `Git-Mate ${stageName} async analysis alarms`,
    });
    const emailSubscription = new sns.CfnSubscription(
      this,
      'OperationsAlarmEmailSubscription',
      {
        protocol: 'email',
        endpoint: alarmEmail.valueAsString,
        topicArn: alarmTopic.topicArn,
      },
    );
    emailSubscription.cfnOptions.condition = hasAlarmEmail;
    const alarmAction = new cloudwatchActions.SnsAction(alarmTopic);

    const alarms = [
      createAlarm(this, 'DeadLetterQueueAlarm', {
        alarmName: `${resourcePrefix}-analysis-dlq-not-empty`,
        alarmDescription: 'At least one analysis message reached the DLQ.',
        metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible({
          period: Duration.minutes(1),
          statistic: 'Maximum',
        }),
        threshold: ASYNC_ANALYSIS_DEFAULTS.dlqAlarmThreshold,
        evaluationPeriods: 1,
      }),
      createAlarm(this, 'QueueAgeAlarm', {
        alarmName: `${resourcePrefix}-analysis-queue-age`,
        alarmDescription:
          'Oldest queued analysis job is at least 10 minutes old.',
        metric: analysisQueue.metricApproximateAgeOfOldestMessage({
          period: Duration.minutes(1),
          statistic: 'Maximum',
        }),
        threshold: ASYNC_ANALYSIS_DEFAULTS.queueAgeAlarmSeconds,
        evaluationPeriods: 2,
      }),
      createAlarm(this, 'ApiErrorsAlarm', {
        alarmName: `${resourcePrefix}-api-errors`,
        alarmDescription: 'API Lambda returned an invocation error.',
        metric: apiFunction.metricErrors({ period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
      }),
      createAlarm(this, 'ApiThrottlesAlarm', {
        alarmName: `${resourcePrefix}-api-throttles`,
        alarmDescription: 'API Lambda was throttled.',
        metric: apiFunction.metricThrottles({ period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
      }),
      createAlarm(this, 'WorkerErrorsAlarm', {
        alarmName: `${resourcePrefix}-worker-errors`,
        alarmDescription: 'Worker Lambda returned an invocation error.',
        metric: workerFunction.metricErrors({ period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
      }),
      createAlarm(this, 'WorkerThrottlesAlarm', {
        alarmName: `${resourcePrefix}-worker-throttles`,
        alarmDescription: 'Worker Lambda was throttled.',
        metric: workerFunction.metricThrottles({ period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
      }),
      createAlarm(this, 'WorkerDurationAlarm', {
        alarmName: `${resourcePrefix}-worker-duration-p95`,
        alarmDescription: 'Worker p95 duration is at least four minutes.',
        metric: workerFunction.metricDuration({
          period: Duration.minutes(5),
          statistic: 'p95',
        }),
        threshold: 240_000,
        evaluationPeriods: 2,
      }),
      createAlarm(this, 'ReconcilerErrorsAlarm', {
        alarmName: `${resourcePrefix}-reconciler-errors`,
        alarmDescription: 'Reconciler Lambda returned an invocation error.',
        metric: reconcilerFunction.metricErrors({
          period: Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
      }),
      createAlarm(this, 'WorkerJobFailuresAlarm', {
        alarmName: `${resourcePrefix}-worker-job-failures`,
        alarmDescription: 'Worker emitted a structured job failure event.',
        metric: new cloudwatch.Metric({
          namespace: metricNamespace,
          metricName: 'WorkerJobFailures',
          period: Duration.minutes(5),
          statistic: 'Sum',
        }),
        threshold: 1,
        evaluationPeriods: 1,
      }),
      createAlarm(this, 'ReconcilerItemFailuresAlarm', {
        alarmName: `${resourcePrefix}-reconciler-item-failures`,
        alarmDescription:
          'Reconciler emitted an item reconciliation or publish failure event.',
        metric: new cloudwatch.Metric({
          namespace: metricNamespace,
          metricName: 'ReconcilerItemFailures',
          period: Duration.minutes(5),
          statistic: 'Sum',
        }),
        threshold: 1,
        evaluationPeriods: 1,
      }),
    ];
    for (const alarm of alarms) {
      alarm.addAlarmAction(alarmAction);
      alarm.addOkAction(alarmAction);
    }

    const dashboard = new cloudwatch.Dashboard(this, 'OperationsDashboard', {
      dashboardName: `${resourcePrefix}-async-analysis`,
    });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Queue depth and DLQ',
        left: [
          analysisQueue.metricApproximateNumberOfMessagesVisible(),
          analysisQueue.metricApproximateNumberOfMessagesNotVisible(),
          deadLetterQueue.metricApproximateNumberOfMessagesVisible(),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Oldest queued message (seconds)',
        left: [analysisQueue.metricApproximateAgeOfOldestMessage()],
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda errors and throttles',
        left: [
          apiFunction.metricErrors(),
          apiFunction.metricThrottles(),
          workerFunction.metricErrors(),
          workerFunction.metricThrottles(),
          reconcilerFunction.metricErrors(),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Worker duration',
        left: [
          workerFunction.metricDuration({ statistic: 'p95' }),
          workerFunction.metricDuration({ statistic: 'p99' }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Worker concurrent executions',
        left: [
          workerFunction.metric('ConcurrentExecutions', {
            statistic: 'Maximum',
          }),
        ],
      }),
    );

    new CfnOutput(this, 'ApiFunctionUrl', { value: apiUrl.url });
    new CfnOutput(this, 'AnalysisQueueUrl', { value: analysisQueue.queueUrl });
    new CfnOutput(this, 'AnalysisDeadLetterQueueUrl', {
      value: deadLetterQueue.queueUrl,
    });
    new CfnOutput(this, 'OperationsDashboardName', {
      value: dashboard.dashboardName,
    });
    new CfnOutput(this, 'OperationsAlarmTopicArn', {
      value: alarmTopic.topicArn,
    });
  }
}

function validateStageName(value: string): string {
  const stageName = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,19}$/u.test(stageName)) {
    throw new Error(
      'stageName must contain 1-20 lowercase letters, numbers, or hyphens.',
    );
  }
  return stageName;
}

function createLogGroup(
  scope: Construct,
  id: string,
  functionName: string,
): logs.LogGroup {
  return new logs.LogGroup(scope, id, {
    logGroupName: `/aws/lambda/${functionName}`,
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.RETAIN,
  });
}

function createLambdaRole(
  scope: Construct,
  id: string,
  logGroup: logs.ILogGroup,
): iam.Role {
  const role = new iam.Role(scope, id, {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    description: `Least-privilege execution role for ${id}`,
  });
  logGroup.grantWrite(role);
  return role;
}

function createAlarm(
  scope: Construct,
  id: string,
  props: cloudwatch.AlarmProps,
): cloudwatch.Alarm {
  return new cloudwatch.Alarm(scope, id, {
    ...props,
    comparisonOperator:
      cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  });
}
