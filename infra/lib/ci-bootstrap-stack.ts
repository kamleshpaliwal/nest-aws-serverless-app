import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

// The OIDC `sub` claim for this repo contains IMMUTABLE numeric ids (owner id after "@", repo id
// after "@"), not just names: names can be released and re-registered by someone else
// ("repo-jacking"), ids never are. Value taken from a real token (printed by a debug step):
//   repo:kamleshpaliwal@37514370/nest-aws-serverless-app@1465804170:pull_request
const GITHUB_SUBJECT_REPO = 'kamleshpaliwal@37514370/nest-aws-serverless-app@1465804170';
const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';
const CDK_QUALIFIER = 'hnb659fds'; // default `cdk bootstrap` qualifier (see the CDKToolkit stack)

/**
 * Deployed ONCE, by hand, with admin credentials. The pipeline can't create its own
 * permissions (chicken and egg), so this lives apart from the application stack.
 */
export class CiBootstrapStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Registers GitHub as a trusted identity provider in this account.
    // (Thumbprints are no longer needed: AWS validates GitHub's certificate chain itself.)
    const provider = new iam.OidcProviderNative(this, 'GithubOidcProvider', {
      url: `https://${GITHUB_OIDC_HOST}`,
      clientIds: ['sts.amazonaws.com'], // the token's "aud" claim must be this
    });

    // Builds a role that ONLY a specific GitHub token subject can assume.
    const githubRole = (id: string, sub: string, description: string) =>
      new iam.Role(this, id, {
        description,
        maxSessionDuration: Duration.hours(1),
        assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
          StringEquals: {
            [`${GITHUB_OIDC_HOST}:aud`]: 'sts.amazonaws.com',
            // The security boundary. Without this, ANY GitHub repo could assume the role.
            [`${GITHUB_OIDC_HOST}:sub`]: sub,
          },
        }),
      });

    const bootstrapRoleArn = (kind: string) =>
      `arn:${this.partition}:iam::${this.account}:role/cdk-${CDK_QUALIFIER}-${kind}-role-${this.account}-${this.region}`;

    // ---- Pull requests: read-only. Can run `cdk diff`, cannot deploy anything.
    const planRole = githubRole(
      'GithubPlanRole',
      `repo:${GITHUB_SUBJECT_REPO}:pull_request`,
      'GitHub Actions on pull requests: cdk diff only',
    );
    planRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [bootstrapRoleArn('lookup')],
      }),
    );

    // ---- main branch only: may deploy, by assuming CDK's bootstrap roles.
    // The CI role itself holds almost no permissions; the bootstrap roles do the real work.
    const deployRole = githubRole(
      'GithubDeployRole',
      `repo:${GITHUB_SUBJECT_REPO}:ref:refs/heads/main`,
      'GitHub Actions on main: cdk deploy',
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: ['deploy', 'file-publishing', 'image-publishing', 'lookup'].map(bootstrapRoleArn),
      }),
    );

    new CfnOutput(this, 'PlanRoleArn', { value: planRole.roleArn });
    new CfnOutput(this, 'DeployRoleArn', { value: deployRole.roleArn });
  }
}
