import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AsyncAnalysisStack } from '../lib/async-analysis-stack';

type AwsResult = { status: number; stdout: string; stderr: string };
type AwsExecute = (
  command: string,
  arguments_: string[],
  options: { input?: string },
) => AwsResult;
const { disable } = createRequire(__filename)(
  '../../scripts/disable_async_analysis.cjs',
) as {
  disable: (
    stage: string,
    execute: AwsExecute,
    log: (message: string) => void,
  ) => void;
};

describe('configuration-only emergency disable', () => {
  const fixture = () => {
    const stack = new AsyncAnalysisStack(new App(), 'TestStack', {
      env: { account: '111111111111', region: 'ap-northeast-2' },
      stageName: 'production',
    });
    const template = Template.fromStack(stack).toJSON() as {
      Parameters: Record<string, unknown>;
      Resources: Record<
        string,
        {
          Type: string;
          Properties: Record<string, any> & {
            Environment: { Variables: Record<string, string> };
          };
        }
      >;
    };
    const deployed = {
      StackName: 'GitMateAsyncAnalysis-production',
      StackStatus: 'UPDATE_COMPLETE',
      Parameters: Object.keys(template.Parameters).map((ParameterKey) => ({
        ParameterKey,
        ParameterValue: 'MASKED-DO-NOT-RESUBMIT',
      })),
      Capabilities: ['CAPABILITY_NAMED_IAM'],
    };
    return { template, deployed };
  };
  const success = (body: unknown): AwsResult => ({
    status: 0,
    stdout: JSON.stringify(body),
    stderr: '',
  });
  const harness = () => {
    const state = fixture();
    let update: Record<string, any> | undefined;
    const execute = jest.fn<AwsResult, Parameters<AwsExecute>>(
      (_command, arguments_, options) => {
        if (arguments_.includes('describe-stacks'))
          return success({ Stacks: [state.deployed] });
        if (arguments_.includes('get-template'))
          return success({ TemplateBody: state.template });
        if (arguments_.includes('update-stack')) {
          update = JSON.parse(options.input!) as Record<string, any>;
          return success({ StackId: 'test-stack' });
        }
        if (arguments_.includes('wait')) return success({});
        throw new Error('Unexpected command');
      },
    );
    const log = jest.fn();
    return { ...state, execute, log, update: () => update };
  };

  it('changes only the five stop toggles and preserves deployed images, parameters and capabilities', () => {
    const state = harness();
    const original = JSON.stringify(state.template);
    disable('production', state.execute, state.log);
    const update = state.update()!;
    const patched = JSON.parse(
      update.TemplateBody as string,
    ) as typeof state.template;
    const expected = JSON.parse(original) as typeof state.template;
    for (const resource of Object.values(expected.Resources)) {
      if (resource.Type === 'AWS::Lambda::Function')
        resource.Properties.Environment.Variables.ASYNC_ANALYSIS_ENABLED =
          'false';
      if (resource.Type === 'AWS::Lambda::EventSourceMapping')
        resource.Properties.Enabled = false;
      if (resource.Type === 'AWS::Events::Rule')
        resource.Properties.State = 'DISABLED';
    }
    expect(patched).toEqual(expected);
    expect(update.Parameters).toEqual(
      Object.keys(state.template.Parameters)
        .sort()
        .map((ParameterKey) => ({ ParameterKey, UsePreviousValue: true })),
    );
    expect(update.Capabilities).toEqual(state.deployed.Capabilities);
    expect(JSON.stringify(update)).not.toContain('MASKED-DO-NOT-RESUBMIT');
    expect(state.execute).toHaveBeenCalledTimes(4);
    for (const [command, args] of state.execute.mock.calls) {
      expect(command).toBe('aws');
      expect(args).toContain('cloudformation');
      expect(args).not.toContain('secretsmanager');
    }
    expect(state.execute.mock.calls[1][1]).toEqual(
      expect.arrayContaining(['--template-stage', 'Original']),
    );
    expect(state.execute.mock.calls[2][1]).toEqual(
      expect.arrayContaining(['--cli-input-json', 'file:///dev/stdin']),
    );
    expect(state.execute.mock.calls[3][1]).toContain('stack-update-complete');
  });

  it('returns without updating when the deployed stack is already disabled', () => {
    const state = harness();
    for (const resource of Object.values(state.template.Resources)) {
      if (resource.Type === 'AWS::Lambda::Function')
        resource.Properties.Environment.Variables.ASYNC_ANALYSIS_ENABLED =
          'false';
      if (resource.Type === 'AWS::Lambda::EventSourceMapping')
        resource.Properties.Enabled = false;
      if (resource.Type === 'AWS::Events::Rule')
        resource.Properties.State = 'DISABLED';
    }
    disable('production', state.execute, state.log);
    expect(state.execute).toHaveBeenCalledTimes(2);
    expect(state.log).toHaveBeenCalledWith(
      expect.stringContaining('already disabled'),
    );
  });

  it.each([
    'missing function',
    'wrong queue',
    'wrong schedule',
    'wrong stack',
    'busy stack',
    'missing parameter',
    'oversized template',
  ])('refuses %s before submitting an update', (failure) => {
    const state = harness();
    const resources = Object.values(state.template.Resources);
    if (failure === 'missing function')
      delete state.template.Resources[
        Object.keys(state.template.Resources).find(
          (key) =>
            state.template.Resources[key].Type === 'AWS::Lambda::Function',
        )!
      ];
    if (failure === 'wrong queue')
      resources.find(
        (resource) => resource.Type === 'AWS::Lambda::EventSourceMapping',
      )!.Properties.EventSourceArn = { 'Fn::GetAtt': ['OtherQueue', 'Arn'] };
    if (failure === 'wrong schedule')
      resources.find(
        (resource) => resource.Type === 'AWS::Events::Rule',
      )!.Properties.Targets = [];
    if (failure === 'wrong stack') state.deployed.StackName = 'OtherStack';
    if (failure === 'busy stack')
      state.deployed.StackStatus = 'UPDATE_IN_PROGRESS';
    if (failure === 'missing parameter') state.deployed.Parameters.pop();
    if (failure === 'oversized template')
      resources[0].Properties.TestPadding = 'x'.repeat(51200);
    expect(() => disable('production', state.execute, state.log)).toThrow();
    expect(state.update()).toBeUndefined();
  });

  it('sanitizes AWS failures and does not expose raw output', () => {
    const execute: AwsExecute = () => ({
      status: 1,
      stdout: 'secret-stdout',
      stderr: 'secret-stderr',
    });
    const log = jest.fn();
    expect(() => disable('production', execute, log)).toThrow(
      'CloudFormation describe-stacks failed; inspect stack events in AWS.',
    );
    expect(log).not.toHaveBeenCalled();
  });

  it('refuses an invalid stage before invoking AWS', () => {
    const state = harness();
    expect(() => disable('../production', state.execute, state.log)).toThrow(
      'Invalid stage',
    );
    expect(state.execute).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON without exposing the response', () => {
    const state = harness();
    state.execute.mockReturnValue({
      status: 0,
      stdout: 'secret-invalid-json',
      stderr: '',
    });
    expect(() => disable('production', state.execute, state.log)).toThrow(
      'CloudFormation describe-stacks returned invalid JSON.',
    );
    expect(state.log).not.toHaveBeenCalled();
  });

  it('reports a waiter failure without claiming the pipeline stopped or leaking raw errors', () => {
    const state = harness();
    const original = state.execute.getMockImplementation()!;
    state.execute.mockImplementation((command, args, options) =>
      args.includes('wait')
        ? { status: 255, stdout: 'secret-stdout', stderr: 'secret-stderr' }
        : original(command, args, options),
    );
    expect(() => disable('production', state.execute, state.log)).toThrow(
      'CloudFormation wait stack-update-complete failed; inspect stack events in AWS.',
    );
    expect(state.log).not.toHaveBeenCalled();
  });

  it('accepts an AWS no-update response without starting a waiter', () => {
    const state = harness();
    const original = state.execute.getMockImplementation()!;
    state.execute.mockImplementation((command, args, options) =>
      args.includes('update-stack')
        ? {
            status: 255,
            stdout: '',
            stderr: 'ValidationError: No updates are to be performed.',
          }
        : original(command, args, options),
    );
    disable('production', state.execute, state.log);
    expect(state.execute).toHaveBeenCalledTimes(3);
  });

  it('runs disable before frontend/secret checks without invoking npm, npx, or the AWS secret lookup', () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'git-mate-disable-test-'),
    );
    writeFileSync(
      path.join(directory, 'node'),
      '#!/bin/sh\nprintf "%s\\n" "$@"\n',
      { mode: 0o700 },
    );
    for (const executable of ['npm', 'npx', 'aws']) {
      writeFileSync(path.join(directory, executable), '#!/bin/sh\nexit 93\n', {
        mode: 0o700,
      });
    }
    try {
      const result = spawnSync(
        'bash',
        [
          path.resolve(__dirname, '../../scripts/deploy_async_analysis.sh'),
          'disable',
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            STAGE: 'production',
            FRONTEND_URL: 'invalid',
            RUNTIME_SECRET_ARN: '',
            RUNTIME_SECRET_VERSION_ID: '',
            PATH: `${directory}${path.delimiter}${process.env.PATH ?? ''}`,
          },
        },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(
        `${path.resolve(__dirname, '../../scripts/disable_async_analysis.cjs')}\nproduction\n`,
      );
      expect(result.stderr).toBe('');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
