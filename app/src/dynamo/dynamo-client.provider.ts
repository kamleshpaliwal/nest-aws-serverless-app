import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** DI token for the DocumentClient. A Symbol can't collide with any other token. */
export const DYNAMO_DOC_CLIENT = Symbol('DYNAMO_DOC_CLIENT');

export const dynamoDocClientProvider: Provider = {
  provide: DYNAMO_DOC_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): DynamoDBDocumentClient => {
    const endpoint = config.get<string>('DYNAMODB_ENDPOINT');

    const client = new DynamoDBClient(
      endpoint
        ? {
            // Local development: point at DynamoDB Local with throwaway credentials.
            endpoint,
            region: config.get<string>('AWS_REGION', 'ap-south-1'),
            credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
          }
        : {}, // Real AWS: region + credentials come from the default provider chain
              // (on Lambda: AWS_REGION env var and the execution role).
    );

    return DynamoDBDocumentClient.from(client, {
      // Our optional `description` can be undefined; the SDK rejects undefined by default.
      marshallOptions: { removeUndefinedValues: true },
    });
  },
};
