#!/usr/bin/env node
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { AsyncAnalysisStack } from '../lib/async-analysis-stack';

const app = new App();
const stageName = contextString(app, 'stage', 'production');

new AsyncAnalysisStack(app, `GitMateAsyncAnalysis-${stageName}`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  stageName,
  asyncAnalysisEnabled: contextBoolean(app, 'asyncAnalysisEnabled', true),
  workerEnabled: contextBoolean(app, 'workerEnabled', true),
  description:
    'Git-Mate asynchronous analysis API, FIFO worker pipeline, reconciliation, and monitoring',
});

function contextString(app: App, name: string, defaultValue: string): string {
  const value: unknown = app.node.tryGetContext(name);
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} context must be a non-empty string.`);
  }
  return value.trim();
}

function contextBoolean(
  app: App,
  name: string,
  defaultValue: boolean,
): boolean {
  const value: unknown = app.node.tryGetContext(name);
  if (value === undefined) {
    return defaultValue;
  }
  if (value === true || value === 'true') {
    return true;
  }
  if (value === false || value === 'false') {
    return false;
  }
  throw new Error(`${name} context must be true or false.`);
}
