import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';

export class ImageBuilderStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const sourceBucket = new s3.Bucket(this, 'SourceBundleBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      lifecycleRules: [{ expiration: cdk.Duration.days(7) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const repository = new ecr.Repository(this, 'ImageRepository', {
      repositoryName: 'finop-api',
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 10 }],
    });

    const project = new codebuild.Project(this, 'ContainerBuildProject', {
      projectName: 'finop-container-build',
      description: 'Build the FINOP application image in AWS CodeBuild and publish it to ECR.',
      source: codebuild.Source.s3({
        bucket: sourceBucket,
        path: 'source.tar.gz',
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.MEDIUM,
        privileged: true,
        environmentVariables: {
          REPOSITORY_URI: { value: repository.repositoryUri },
          IMAGE_TAG: { value: 'unset' },
        },
      },
      timeout: cdk.Duration.minutes(60),
      logging: {
        cloudWatch: { logGroup: new logs.LogGroup(this, 'BuildLogs', {
          logGroupName: '/aws/codebuild/finop-container-build',
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.RETAIN,
        }) },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'tar -xzf source.tar.gz && rm source.tar.gz && pwd && find . -maxdepth 3 -type f | head -40',
              'aws ecr get-login-password --region "$AWS_DEFAULT_REGION" | docker login --username AWS --password-stdin "$REPOSITORY_URI"',
            ],
          },
          build: {
            commands: [
              'docker build --platform linux/amd64 -t "$REPOSITORY_URI:$IMAGE_TAG" .',
              'docker push "$REPOSITORY_URI:$IMAGE_TAG"',
            ],
          },
        },
      }),
    });
    sourceBucket.grantRead(project.role!);
    repository.grantPullPush(project.role!);
    project.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));

    new cdk.CfnOutput(this, 'SourceBundleBucketName', { value: sourceBucket.bucketName });
    new cdk.CfnOutput(this, 'BuildProjectName', { value: project.projectName });
    new cdk.CfnOutput(this, 'ImageRepositoryUri', { value: repository.repositoryUri });
  }
}
