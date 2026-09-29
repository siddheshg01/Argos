# Deploy FINOP with AWS CDK

The CDK stack in `deploy/cdk/` creates a two-AZ VPC, Application Load Balancer, ECS/Fargate service, encrypted EFS report storage and backups, Secrets Manager secret, CloudWatch logs and alarms, and an SNS topic for alerts. The service starts with one task because the current JSON workflow store does not support concurrent writers. ECS tasks have no public IP; only the ALB is internet facing. The default deployment uses HTTPS and redirects HTTP to HTTPS.

For a demo without a custom domain or certificate, the stack places CloudFront in front of the HTTP-only ALB. Visitors use CloudFront's AWS-generated `https://*.cloudfront.net` URL; the ALB security group only accepts origin traffic from CloudFront's managed prefix list. The AWS-generated viewer URL supports Firebase auth without buying a domain.

## Prerequisites

- An AWS account and credentials available to the AWS CLI/CDK identity. The identity needs permission to bootstrap CDK and create the resources in the stack.
- Node.js 20 or newer, npm, and AWS CDK v2.
- For HTTPS: an ACM certificate ARN in the same region as the stack, valid for the dashboard hostname. The hostname must resolve to the ALB, either through the optional Route 53 context or DNS you manage separately.
- For an AWS-generated HTTPS demo URL: no domain, certificate, or client CIDR is required. CloudFront accepts viewer HTTPS and the ALB accepts origin traffic from CloudFront's managed prefix list.
- AWS account budget alerts are recommended. One NAT gateway, the ALB, Fargate, EFS, logs, and data transfer incur ongoing charges.

Check the selected account and region before deploying:

```powershell
aws sts get-caller-identity
aws configure get region
```

Set your intended region if needed (example):

```powershell
$env:AWS_REGION = "us-east-1"
$env:AWS_DEFAULT_REGION = $env:AWS_REGION
```

## Deploy without local Docker

The repository includes `deploy/cdk/deploy-with-codebuild.ps1`. It deploys a CodeBuild project and ECR repository, packages only the application sources, uploads that bundle to a private S3 bucket, builds and pushes the image in AWS, then deploys the ECS stack using that image. Docker does not need to run on your computer. The AWS identity needs CDK deployment access, permission to upload to the generated S3 bucket, and permission to start/read CodeBuild builds.

From the repository root:

```powershell
.\deploy\cdk\deploy-with-codebuild.ps1
```

The script prints the AWS-generated HTTPS dashboard URL when deployment finishes. Add the `DashboardDistributionDomain` output (without `https://`) to Firebase Authentication's authorized domains. Review CodeBuild logs at `/aws/codebuild/finop-container-build` if the remote build fails. The CodeBuild project, source bucket, ECR images, CloudFront distribution, ECS/Fargate service, ALB, NAT gateway, EFS, and CloudWatch resources incur AWS charges.

## Install, bootstrap, and review

Run these commands from the repository root:

```powershell
cd deploy/cdk
npm ci
npx cdk bootstrap
```

For an HTTPS demo using the AWS-generated CloudFront hostname, synthesize with:

```powershell
npx cdk synth -c demoHttp=true
```

For a custom hostname directly on the ALB, pass your actual ACM certificate ARN:

```powershell
npx cdk synth -c certificateArn=arn:aws:acm:us-east-1:123456789012:certificate/REPLACE_ME
```

If the dashboard domain is in Route 53 and you want CDK to create its alias record, pass all three values with the HTTPS certificate:

```powershell
npx cdk synth `
  -c certificateArn=arn:aws:acm:us-east-1:123456789012:certificate/REPLACE_ME `
  -c domainName=finop.example.com `
  -c hostedZoneId=Z0123456789ABC `
  -c hostedZoneName=example.com
```

The certificate must cover `domainName`. Without the Route 53 values, the stack still deploys and outputs the ALB hostname; create a DNS alias/CNAME at your DNS provider. If the DNS provider is external, pass `-c dashboardOrigin=https://finop.example.com` so the API's CORS policy permits the browser origin. Route 53 deployments infer the origin from `domainName`.

Review the synthesized CloudFormation template before deployment. Check the account, region, certificate, domain, networking, and estimated AWS charges.

## Deploy and configure the API key

AWS-generated HTTPS demo deployment:

```powershell
npx cdk deploy -c demoHttp=true
```

The `DashboardUrl` output uses the CloudFront `*.cloudfront.net` hostname with HTTPS. The ALB origin listener remains HTTP-only but only accepts traffic from CloudFront's managed origin-facing prefix list. Add the distribution domain to Firebase Authentication's authorized domains before testing sign-in.

For a persistent HTTPS deployment instead, use:

```powershell
npx cdk deploy `
  -c certificateArn=arn:aws:acm:us-east-1:123456789012:certificate/REPLACE_ME `
  -c domainName=finop.example.com `
  -c hostedZoneId=Z0123456789ABC `
  -c hostedZoneName=example.com
```

CDK generates a random `FINOP_API_TOKEN` and stores it with an initially empty `GEMINI_API_KEY` in Secrets Manager. After deployment, update the secret JSON locally without putting secret text into shell history or this repository. Retrieve the generated token through the AWS console or a secure local terminal session, and set a real Gemini key before using Gemini-backed analysis. For example, edit the secret in the Secrets Manager console, preserving both JSON keys:

```json
{
  "FINOP_API_TOKEN": "the-generated-value",
  "GEMINI_API_KEY": "your-provider-key"
}
```

Force a new ECS deployment after updating the secret so the containers receive the current version:

```powershell
$Cluster = (aws cloudformation describe-stacks --stack-name FinopStack --query "Stacks[0].Outputs[?OutputKey=='EcsClusterName'].OutputValue" --output text)
$Service = (aws cloudformation describe-stack-resources --stack-name FinopStack --query "StackResources[?ResourceType=='AWS::ECS::Service'].PhysicalResourceId" --output text)
aws ecs update-service --cluster $Cluster --service $Service --force-new-deployment
```

Firebase Authentication is available for email/password, Google, and GitHub accounts. The project values from the Firebase web app are defaults in CDK; optional `FirebaseProjectId`, `FirebaseApiKey`, `FirebaseAuthDomain`, and `FirebaseAppId` parameters override them together. Keep the GitHub OAuth client secret in Firebase Console. After the demo deployment, add the `DashboardDistributionDomain` stack output to Firebase's authorized domains. For custom HTTPS hostnames, use an ACM certificate and domain as described below.

Subscribe the operations team to the stack's `AlarmTopicArn` output. Confirm the HTTPS URL responds at `/api/health` and `/api/ready`. `/api/ready` checks the persistent report volume is writable.

## Load financial data

The image bundles Kaggle's [Sample Superstore dataset](https://www.kaggle.com/datasets/bibirehana/sample-superstore), listed as CC0. When the EFS report volume is empty, the container generates initial Phase 1–3 reports from its 9,994 sales rows before starting the API. This lets the demo dashboard open with data immediately; it is public sample data, not your organization's ledger.

After signing in, use **Choose sales CSV** on the Overview page to replace the sample with your own `.csv` file (up to 50 MB). The API runs the same Phase 1–3 pipeline and stores the source file and generated reports in the EFS-backed `output` directory. The reports remain available across task replacements.

When deploying code updates without local Docker, use `deploy/cdk/deploy-with-codebuild.ps1` from the repository; it packages the current backend and frontend source, builds in AWS CodeBuild, and updates the CDK service image.

## Updates and removal

After changing application code or the Dockerfile, synthesize and deploy again; CDK builds and publishes the image asset as part of deployment. Repeat the same demo or HTTPS context values used for the original deployment:

```powershell
npx cdk diff -c demoHttp=true
npx cdk deploy -c demoHttp=true
```

Keep the certificate and optional domain contexts consistent with the original deployment. EFS and the CloudWatch log group are retained when the stack is removed. Back up or export any needed reports before removal, then remove retained resources deliberately through the AWS console/CLI. Review AWS costs and clean up the NAT gateway, ALB, Fargate service, and other no-longer-needed resources after `cdk destroy`.

The older JSON files in `deploy/aws/` are reference examples; use the CDK stack as the deployment source of truth.
