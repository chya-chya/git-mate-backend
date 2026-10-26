#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

// Reuse the deployed template so an emergency stop never builds or publishes code.
function disable(stage, execute = spawnSync, log = console.log) {
  if (!/^[a-z0-9][a-z0-9-]{0,19}$/.test(stage ?? '')) {
    throw new Error('Invalid stage for emergency stop.');
  }
  const stackName = `GitMateAsyncAnalysis-${stage}`;
  const aws = (operation, args = [], input) => {
    const result = execute(
      'aws',
      [
        ...(process.env.AWS_REGION ? ['--region', process.env.AWS_REGION] : []),
        'cloudformation',
        ...operation.split(' '),
        ...args,
        '--no-cli-pager',
      ],
      {
        encoding: 'utf8',
        input,
        env: { ...process.env, AWS_CLI_AUTO_PROMPT: 'off' },
        maxBuffer: 8 * 1024 * 1024,
        timeout: operation.startsWith('wait ') ? 35 * 60 * 1000 : 60 * 1000,
      },
    );
    if (result.error || result.status !== 0) {
      if (
        operation === 'update-stack' &&
        !result.error &&
        result.status !== 0 &&
        String(result.stderr).includes('No updates are to be performed')
      ) {
        return null;
      }
      // CLI errors can contain parameter/template values: never echo raw output.
      throw new Error(
        `CloudFormation ${operation} failed; inspect stack events in AWS.`,
      );
    }
    if (operation.startsWith('wait ')) return null;
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error(`CloudFormation ${operation} returned invalid JSON.`);
    }
  };
  const invalid = () => {
    throw new Error(
      'Deployed stack does not match the expected async analysis template; no update submitted.',
    );
  };
  const stack = aws('describe-stacks', [
    '--stack-name',
    stackName,
    '--output',
    'json',
  ])?.Stacks;
  if (
    !Array.isArray(stack) ||
    stack.length !== 1 ||
    stack[0].StackName !== stackName ||
    ![
      'CREATE_COMPLETE',
      'UPDATE_COMPLETE',
      'UPDATE_ROLLBACK_COMPLETE',
    ].includes(stack[0].StackStatus)
  )
    invalid();
  const deployed = stack[0];
  let template = aws('get-template', [
    '--stack-name',
    stackName,
    '--template-stage',
    'Original',
    '--output',
    'json',
  ])?.TemplateBody;
  if (typeof template === 'string') {
    try {
      template = JSON.parse(template);
    } catch {
      invalid();
    }
  }
  if (
    !template ||
    typeof template !== 'object' ||
    template.Transform ||
    !template.Resources
  )
    invalid();
  const resources = Object.entries(template.Resources);
  const find = (type, predicate) => {
    const matches = resources.filter(
      ([, resource]) =>
        resource.Type === type && predicate(resource.Properties ?? {}),
    );
    if (matches.length !== 1) invalid();
    return matches[0];
  };
  const prefix = `git-mate-${stage}`;
  const functions = ['api', 'analysis-worker', 'analysis-reconciler'].map(
    (name) =>
      find(
        'AWS::Lambda::Function',
        (properties) => properties.FunctionName === `${prefix}-${name}`,
      ),
  );
  if (
    resources.filter(
      ([, resource]) => resource.Type === 'AWS::Lambda::Function',
    ).length !== 3
  )
    invalid();
  for (const [, resource] of functions) {
    const properties = resource.Properties;
    if (
      properties.PackageType !== 'Image' ||
      !properties.Code?.ImageUri ||
      !['true', 'false'].includes(
        properties.Environment?.Variables?.ASYNC_ANALYSIS_ENABLED,
      )
    )
      invalid();
  }
  const [queueId] = find(
    'AWS::SQS::Queue',
    (properties) =>
      properties.QueueName === `${prefix}-analysis.fifo` &&
      properties.FifoQueue === true,
  );
  const [, mapping] = find(
    'AWS::Lambda::EventSourceMapping',
    (properties) =>
      properties.FunctionName?.Ref === functions[1][0] &&
      JSON.stringify(properties.EventSourceArn) ===
        JSON.stringify({ 'Fn::GetAtt': [queueId, 'Arn'] }),
  );
  if (
    resources.filter(
      ([, resource]) => resource.Type === 'AWS::Lambda::EventSourceMapping',
    ).length !== 1 ||
    typeof mapping.Properties.Enabled !== 'boolean'
  )
    invalid();
  const [, schedule] = find(
    'AWS::Events::Rule',
    (properties) =>
      properties.Name === `${prefix}-analysis-reconciler` &&
      properties.ScheduleExpression === 'rate(1 minute)' &&
      properties.Targets?.length === 1 &&
      JSON.stringify(properties.Targets[0].Arn) ===
        JSON.stringify({ 'Fn::GetAtt': [functions[2][0], 'Arn'] }),
  );
  if (!['ENABLED', 'DISABLED'].includes(schedule.Properties.State)) invalid();
  const parameterKeys = Object.keys(template.Parameters ?? {}).sort();
  if (
    !Array.isArray(deployed.Parameters) ||
    JSON.stringify(
      deployed.Parameters.map((parameter) => parameter.ParameterKey).sort(),
    ) !== JSON.stringify(parameterKeys) ||
    !Array.isArray(deployed.Capabilities ?? []) ||
    (deployed.Capabilities ?? []).some(
      (capability) =>
        ![
          'CAPABILITY_IAM',
          'CAPABILITY_NAMED_IAM',
          'CAPABILITY_AUTO_EXPAND',
        ].includes(capability),
    )
  )
    invalid();
  const before = JSON.stringify(template);
  for (const [, resource] of functions)
    resource.Properties.Environment.Variables.ASYNC_ANALYSIS_ENABLED = 'false';
  mapping.Properties.Enabled = false;
  schedule.Properties.State = 'DISABLED';
  const body = JSON.stringify(template);
  if (body === before) {
    log(`Async analysis is already disabled for ${stackName}.`);
    return;
  }
  if (Buffer.byteLength(body, 'utf8') > 51200) {
    throw new Error(
      'Deployed template exceeds the CloudFormation inline limit; no update submitted.',
    );
  }
  const update = aws(
    'update-stack',
    ['--cli-input-json', 'file:///dev/stdin', '--output', 'json'],
    JSON.stringify({
      StackName: stackName,
      TemplateBody: body,
      Parameters: parameterKeys.map((ParameterKey) => ({
        ParameterKey,
        UsePreviousValue: true,
      })),
      ...(deployed.Capabilities?.length
        ? { Capabilities: deployed.Capabilities }
        : {}),
    }),
  );
  if (update) aws('wait stack-update-complete', ['--stack-name', stackName]);
  log(
    `Async analysis disabled for ${stackName}; deployed images and parameters preserved.`,
  );
}

if (require.main === module) {
  try {
    disable(process.argv[2]);
  } catch (error) {
    // Only locally constructed errors reach here; raw CLI stderr is never exposed.
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { disable };
