import * as path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib/core';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, BundlingOptions } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import { Construct } from 'constructs';

const APP_DIR = path.join(__dirname, '../../app');
// Output of `npm run build:lambda` (run automatically by cdk.json before synth).
const BUILD_DIR = path.join(APP_DIR, 'build/lambda');

export class DocsApiStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------- DynamoDB
    const table = new dynamodb.TableV2(this, 'DocsTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      globalSecondaryIndexes: [
        {
          indexName: 'GSI1', // must match the name used by DynamoDocsRepository
          partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
          // projection defaults to ALL, same as our local table
        },
      ],
      // Learning stack: tear down cleanly. For real data use RemovalPolicy.RETAIN.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ---------------------------------------------------------------------- S3
    const bucket = new s3.Bucket(this, 'UploadsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED, // SSE-S3 at rest
      enforceSSL: true, // bucket policy denies non-HTTPS requests
      cors: [
        {
          // Browsers PUT directly to S3, so S3 must answer the preflight.
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: ['*'], // tighten to your web origin in production
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(7) }],
      // Learning stack only: lets `cdk destroy` delete a non-empty bucket
      // (implemented with a helper Lambda custom resource).
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ------------------------------------------------------- shared Lambda setup
    const bundling: BundlingOptions = {
      // No preCompilation: the entries below are ALREADY tsc-compiled JavaScript
      // (decorator metadata included), so esbuild only has to bundle plain JS.
      // Optional Nest packages we don't install; Nest handles their absence at runtime.
      externalModules: [
        '@nestjs/microservices',
        '@nestjs/microservices/*',
        '@nestjs/websockets',
        '@nestjs/websockets/*',
      ],
      sourceMap: true, // readable stack traces
      minify: false,
    };
    const common = {
      runtime: lambda.Runtime.NODEJS_22_X,
      projectRoot: APP_DIR,
      depsLockFilePath: path.join(APP_DIR, 'package-lock.json'),
      bundling,
      environment: { NODE_OPTIONS: '--enable-source-maps' },
    };

    // ------------------------------------------------------ Lambda #1: Nest API
    const apiFunction = new NodejsFunction(this, 'ApiFunction', {
      ...common,
      entry: path.join(BUILD_DIR, 'lambda.js'),
      handler: 'handler',
      memorySize: 512,
      timeout: Duration.seconds(10), // API Gateway gives up at 30s anyway
      environment: {
        ...common.environment,
        TABLE_NAME: table.tableName,
        BUCKET_NAME: bucket.bucketName,
      },
      logGroup: new logs.LogGroup(this, 'ApiLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    // ------------------------------------------- Lambda #2: S3 "uploaded" handler
    const uploadedFunction = new NodejsFunction(this, 'UploadedFunction', {
      ...common,
      entry: path.join(BUILD_DIR, 'upload-handler.js'),
      handler: 'handler',
      memorySize: 256,
      timeout: Duration.seconds(10),
      deadLetterQueueEnabled: true, // events that keep failing land in an SQS queue, not the void
      environment: { ...common.environment, TABLE_NAME: table.tableName },
      logGroup: new logs.LogGroup(this, 'UploadedLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    // ------------------------------------------------ least-privilege permissions
    // API: create (Put), get (Get), list via GSI (Query). No delete, no update, no scan.
    table.grant(apiFunction, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query');
    // API signs presigned PUTs with its own role, so the role itself needs PutObject
    // (on uploads/* only). The URL can never exceed what the signer is allowed to do.
    bucket.grantPut(apiFunction, 'uploads/*');
    // Uploaded-handler: only UpdateItem.
    table.grant(uploadedFunction, 'dynamodb:UpdateItem');

    // ---------------------------------------------------------- S3 -> Lambda event
    bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(uploadedFunction),
      { prefix: 'uploads/' }, // ignore anything outside uploads/
    );

    // ------------------------------------------------------------ HTTP API Gateway
    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: 'docs-api',
      corsPreflight: {
        allowOrigins: ['*'], // tighten in production
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: ['content-type', 'authorization'],
      },
    });
    httpApi.addRoutes({
      path: '/{proxy+}', // catch-all: NestJS does the routing
      methods: [apigwv2.HttpMethod.ANY],
      integration: new HttpLambdaIntegration('ApiIntegration', apiFunction),
    });

    // ------------------------------------------------------------------- alarms
    // Recipient comes from context so no personal address is committed:
    //   npx cdk deploy -c alertEmail=you@example.com
    const alarmTopic = new sns.Topic(this, 'AlarmTopic');
    const alertEmail = this.node.tryGetContext('alertEmail') as string | undefined;
    if (alertEmail) {
      alarmTopic.addSubscription(new subscriptions.EmailSubscription(alertEmail));
    }
    const notify = new cwActions.SnsAction(alarmTopic);
    const fiveMinutes = Duration.minutes(5);

    // 1. What users experience. NOTE: Lambda's own "Errors" metric would miss our HTTP 500s,
    //    because the Nest exception filter handles the error and Lambda sees a SUCCESSFUL
    //    invocation that returned statusCode 500. API Gateway's 5xx metric sees them.
    httpApi
      .metricServerError({ period: fiveMinutes, statistic: 'Sum' })
      .createAlarm(this, 'Api5xxAlarm', {
        alarmDescription: 'API returned 5xx responses',
        threshold: 1,
        evaluationPeriods: 1,
        // No traffic = no data points; that is not a problem, so don't alarm on it.
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })
      .addAlarmAction(notify);

    // 2. Async path: no HTTP response exists, so watch unhandled errors directly.
    uploadedFunction
      .metricErrors({ period: fiveMinutes, statistic: 'Sum' })
      .createAlarm(this, 'UploadedFunctionErrorsAlarm', {
        alarmDescription: 'S3-event handler threw (Lambda will retry twice, then DLQ)',
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })
      .addAlarmAction(notify);

    // 3. Events that failed every retry end up here and need a human.
    uploadedFunction
      .deadLetterQueue!.metricApproximateNumberOfMessagesVisible({ period: fiveMinutes })
      .createAlarm(this, 'DeadLetterQueueAlarm', {
        alarmDescription: 'A failed S3 event is waiting in the dead-letter queue',
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })
      .addAlarmAction(notify);

    // ------------------------------------------------------------------- outputs
    new CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'BucketName', { value: bucket.bucketName });
  }
}
