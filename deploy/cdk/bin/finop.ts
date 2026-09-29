#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { FinopStack } from '../lib/finop-stack';
import { ImageBuilderStack } from '../lib/image-builder-stack';

const app = new cdk.App();
const builderOnly = app.node.tryGetContext('imageBuilderOnly') === true || app.node.tryGetContext('imageBuilderOnly') === 'true';
new ImageBuilderStack(app, 'ImageBuilderStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
if (!builderOnly) {
  const certArn = app.node.tryGetContext('certificateArn') as string | undefined;
  const demoHttp = app.node.tryGetContext('demoHttp') === true || app.node.tryGetContext('demoHttp') === 'true';
  const allowedClientCidr = app.node.tryGetContext('allowedClientCidr') as string | undefined;
  if (!demoHttp && !certArn) throw new Error('Pass -c certificateArn=... for a production HTTPS deployment.');

  new FinopStack(app, 'FinopStack', {
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION,
    },
    certificateArn: certArn,
    demoHttp,
    allowedClientCidr,
    dashboardOrigin: app.node.tryGetContext('dashboardOrigin') as string | undefined,
    firebaseProjectId: (app.node.tryGetContext('firebaseProjectId') as string | undefined) ?? 'finops-10a45',
    firebaseApiKey: (app.node.tryGetContext('firebaseApiKey') as string | undefined) ?? 'AIzaSyDuchr8Ad_PZeiymG69o6PrpIxwqsIjRzw',
    firebaseAuthDomain: (app.node.tryGetContext('firebaseAuthDomain') as string | undefined) ?? 'finops-10a45.firebaseapp.com',
    firebaseAppId: (app.node.tryGetContext('firebaseAppId') as string | undefined) ?? '1:423244544710:web:3018ec0e6148372d55b5c7',
  });
}
