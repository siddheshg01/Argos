import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';

interface FinopStackProps extends cdk.StackProps {
  certificateArn?: string;
  demoHttp?: boolean;
  allowedClientCidr?: string;
  dashboardOrigin?: string;
  firebaseProjectId?: string;
  firebaseApiKey?: string;
  firebaseAuthDomain?: string;
  firebaseAppId?: string;
}

export class FinopStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FinopStackProps) {
    super(scope, id, props);

    const domainName = this.node.tryGetContext('domainName') as string | undefined;
    const hostedZoneId = this.node.tryGetContext('hostedZoneId') as string | undefined;
    const hostedZoneName = this.node.tryGetContext('hostedZoneName') as string | undefined;
    if ((hostedZoneId || hostedZoneName) && !(hostedZoneId && hostedZoneName && domainName)) {
      throw new Error('For Route 53 DNS, provide domainName, hostedZoneId, and hostedZoneName together.');
    }
    const vpc = new ec2.Vpc(this, 'Vpc', {
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    const secret = new secretsmanager.Secret(this, 'ApplicationSecrets', {
      secretName: 'finop/application',
      description: 'FINOP server-side API token and Gemini API key. Update Gemini key after deployment.',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ GEMINI_API_KEY: '' }),
        generateStringKey: 'FINOP_API_TOKEN',
        passwordLength: 48,
        excludePunctuation: true,
      },
    });

    const fileSystem = new efs.FileSystem(this, 'ReportFileSystem', {
      vpc,
      encrypted: true,
      throughputMode: efs.ThroughputMode.BURSTING,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      enableAutomaticBackups: true,
    });
    const accessPoint = fileSystem.addAccessPoint('ReportAccessPoint', {
      path: '/finop/output',
      posixUser: { uid: '999', gid: '999' },
      createAcl: { ownerUid: '999', ownerGid: '999', permissions: '750' },
    });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });
    const task = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      cpu: 1024,
      memoryLimitMiB: 3072,
      volumes: [{
        name: 'finop-output',
        efsVolumeConfiguration: {
          fileSystemId: fileSystem.fileSystemId,
          transitEncryption: 'ENABLED',
          authorizationConfig: { accessPointId: accessPoint.accessPointId, iam: 'ENABLED' },
        },
      }],
    });
    task.addToTaskRolePolicy(new iam.PolicyStatement({
      actions: ['elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite', 'elasticfilesystem:DescribeMountTargets'],
      resources: [fileSystem.fileSystemArn],
    }));
    const prebuiltImageUri = this.node.tryGetContext('imageUri') as string | undefined;
    let image: ecs.ContainerImage;
    if (prebuiltImageUri) {
      const imageTag = prebuiltImageUri.substring(prebuiltImageUri.lastIndexOf(':') + 1);
      const repository = ecr.Repository.fromRepositoryName(this, 'FinopImageRepository', 'finop-api');
      image = ecs.ContainerImage.fromEcrRepository(repository, imageTag);
    } else {
      image = ecs.ContainerImage.fromAsset(path.resolve(__dirname, '../../..'), {
        platform: ecrAssets.Platform.LINUX_AMD64,
      });
    }
    const logGroup = new logs.LogGroup(this, 'ApiLogs', {
      logGroupName: '/ecs/finop-api',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const origin = props.dashboardOrigin ?? (domainName ? `https://${domainName}` : '');
    const container = task.addContainer('Api', {
      image,
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'api' }),
      environment: {
        PORT: '8000',
        FINOP_CORS_ORIGINS: origin,
        ...(props.firebaseProjectId ? { FINOP_FIREBASE_PROJECT_ID: props.firebaseProjectId } : {}),
        ...(props.firebaseApiKey ? { FINOP_FIREBASE_API_KEY: props.firebaseApiKey } : {}),
        ...(props.firebaseAuthDomain ? { FINOP_FIREBASE_AUTH_DOMAIN: props.firebaseAuthDomain } : {}),
        ...(props.firebaseAppId ? { FINOP_FIREBASE_APP_ID: props.firebaseAppId } : {}),
      },
      secrets: {
        FINOP_API_TOKEN: ecs.Secret.fromSecretsManager(secret, 'FINOP_API_TOKEN'),
        GEMINI_API_KEY: ecs.Secret.fromSecretsManager(secret, 'GEMINI_API_KEY'),
      },
      healthCheck: {
        command: ['CMD-SHELL', "python -c \"import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/ready', timeout=3)\" || exit 1"],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(180),
      },
      stopTimeout: cdk.Duration.seconds(60),
    });
    container.addPortMappings({ containerPort: 8000, protocol: ecs.Protocol.TCP });
    container.addMountPoints({ containerPath: '/app/output', sourceVolume: 'finop-output', readOnly: false });

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: task,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: cdk.Duration.seconds(240),
      enableExecuteCommand: false,
    });

    fileSystem.connections.allowDefaultPortFrom(service);

    const alb = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      dropInvalidHeaderFields: true,
    });
    const listener = props.demoHttp
      ? alb.addListener('HttpDemoListener', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        open: false,
      })
      : alb.addListener('HttpsListener', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [acm.Certificate.fromCertificateArn(this, 'Certificate', props.certificateArn!)],
        sslPolicy: elbv2.SslPolicy.TLS13_RES,
        open: true,
      });
    if (props.demoHttp) {
      // CloudFront provides the public HTTPS endpoint; only CloudFront origin-facing
      // addresses may reach this HTTP-only origin (managed prefix list, us-east-1).
      alb.connections.allowFrom(ec2.Peer.prefixList('pl-3b927c52'), ec2.Port.tcp(80), 'CloudFront origin requests');
    }
    const targetGroup = listener.addTargets('ApiTargets', {
      port: 8000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: '/api/ready',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });
    if (!props.demoHttp) {
      alb.addListener('HttpRedirect', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        open: true,
        defaultAction: elbv2.ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true }),
      });
    }

    const dashboardDistribution = props.demoHttp ? new cloudfront.Distribution(this, 'HttpsDashboard', {
      defaultBehavior: {
        origin: new origins.LoadBalancerV2Origin(alb, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      comment: 'HTTPS entry point for FINOP demo and Firebase authentication',
    }) : undefined;

    const alarmTopic = new sns.Topic(this, 'OperationsAlerts', {
      displayName: 'FINOP deployment alerts',
    });
    const unhealthyAlarm = new cloudwatch.Alarm(this, 'UnhealthyTargetsAlarm', {
      metric: targetGroup.metrics.unhealthyHostCount(),
      threshold: 1,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    unhealthyAlarm.addAlarmAction(new actions.SnsAction(alarmTopic));
    const errorsAlarm = new cloudwatch.Alarm(this, 'TargetErrorsAlarm', {
      metric: alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
        period: cdk.Duration.minutes(5), statistic: 'sum',
      }),
      threshold: 10,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    errorsAlarm.addAlarmAction(new actions.SnsAction(alarmTopic));

    if (domainName && hostedZoneId && hostedZoneName) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId,
        zoneName: hostedZoneName,
      });
      new route53.ARecord(this, 'DashboardAlias', {
        zone,
        recordName: domainName.replace(`.${hostedZoneName}`, ''),
        target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(alb)),
      });
    }

    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: dashboardDistribution ? `https://${dashboardDistribution.distributionDomainName}` : `https://${domainName ?? alb.loadBalancerDnsName}`,
    });
    if (dashboardDistribution) new cdk.CfnOutput(this, 'DashboardDistributionDomain', { value: dashboardDistribution.distributionDomainName });
    new cdk.CfnOutput(this, 'ApplicationSecretArn', { value: secret.secretArn });
    new cdk.CfnOutput(this, 'AlarmTopicArn', { value: alarmTopic.topicArn });
    new cdk.CfnOutput(this, 'EcsClusterName', { value: cluster.clusterName });
  }
}
