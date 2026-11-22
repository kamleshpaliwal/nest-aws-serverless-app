#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { CiBootstrapStack } from '../lib/ci-bootstrap-stack';
import { DocsApiStack } from '../lib/docs-api-stack';

const app = new cdk.App();

// Explicit environment: these stacks can only ever deploy to this account + region.
const env = { account: '933022260230', region: 'ap-south-1' };

new DocsApiStack(app, 'DocsApiStack', { env });

// Deployed once by hand (admin credentials): GitHub OIDC provider + CI roles.
new CiBootstrapStack(app, 'CiBootstrapStack', { env });
