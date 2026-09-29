# Agentic AI Financial Operations Platform — Phase 1

This project turns sales transaction datasets into deterministic, structured financial and business intelligence. It uses no LLM or agent framework for Phases 1–3. Source fields are discovered at runtime; unavailable financial measures remain unavailable.

Phase 2 adds a deterministic Root Cause Investigation Engine. It compares adjacent observed calendar months for revenue, quantity, and unique orders, flags absolute changes of at least 5% by default, and ranks product, category, city/state, and pseudonymized customer contributions. Findings describe associations and contributions; they do not claim causation.

Phase 3 adds a deterministic Financial Forecasting Engine for revenue, quantity, and orders. It compares naive, moving-average, Holt, and ARIMA candidates using chronological validation, reports a held-out test score, and forecasts 3, 6, and 12 months. Holt-Winters/SARIMA candidates are considered only when the training portion supports annual seasonality. Profit is not forecast.

## Dataset

An empty deployment is seeded from `data/sample_superstore.csv`, the 9,994-row Kaggle Sample Superstore dataset (CC0). It includes sales, profit, quantity, product/category, region, and order-date fields. This is public demo data, not your organization's actual ledger. The dashboard CSV importer can replace it with your own dataset; missing financial measures remain unavailable rather than being inferred.

## Architecture

```text
Dataset → Validation → Cleaning → Column Mapping → Feature Engineering
        → KPI Engine → Segmentation → Trend Analysis → Risk Indicators → Financial Report
```

Business logic lives in `src/financial_intelligence/`. Quality score starts at 100 and subtracts capped, documented penalties for missingness, exact duplicate rows, invalid dates/numbers, and missing core concepts. Risk score adds 15 for each first-to-last observed decline in revenue/profit/profit margin/quantity, 10 for a product/category/location revenue share above 50%, and 20 (or 35 below 60 quality points) for poor data quality; scores are capped at 100. Both are internal analytical heuristics.

## Installation

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

## Run and test

```powershell
python main.py
pytest
```

The Phase 1 pipeline writes `output/financial_report.json`, `output/financial_summary.csv`, and supported charts under `output/charts/`. The integrated Phase 2 run also writes `output/root_cause_report.json`, `output/root_cause_summary.csv`, and major-contributor charts under `output/charts/root_cause/`. Phase 3 writes `output/forecast_report.json`, `output/forecast_summary.csv`, and historical/forecast, comparison, and interval charts under `output/charts/forecast/`. It raises a clear `FileNotFoundError` if the source CSV is missing.

## Beginner guide to the functions

`load_dataset(path)` accepts a CSV path and returns a pandas DataFrame with shape, columns, types, missingness, and duplicate counts in its `attrs`. `discover_schema(df)` maps recognized source names to internal concepts. `validate_dataset(df, schema)` returns quality findings and the explainable score. `clean_dataset(df, schema)` returns cleaned rows plus a summary; duplicate rows are counted and invalid dates are quarantined. `engineer_features(df, schema)` adds only supported formulas and describes them. The KPI, segmentation, trends, concentration, and risk functions each accept the data and discovered mapping needed for their calculations. `FinancialIntelligencePipeline(path).run()` connects these steps and writes the outputs.

For example, `load_dataset("data/raw/amazon_sales_2024.csv")` reads the CSV into a DataFrame. `discover_schema(df)` then maps a column such as `total_sales` to the internal revenue concept only if that column is actually present.

## Future phases

Phase 4 LLM Financial Analyst; Phase 5 RAG / Policy Intelligence; Phase 6 Multi-Agent System; Phase 7 Action & Workflow Automation; Phase 8 AWS Deployment & Monitoring.

## FINOP Web Platform (Phases 1–7)

The dashboard is a React/Vite application backed by a FastAPI adapter. It reads existing Phase 1–7 JSON outputs and calls the existing Gemini, RAG, multi-agent, and approval-gated workflow modules. It does not load transaction-level data into the browser or duplicate financial calculations.

### Run the API (Windows)

From the project root:

```powershell
python -m pip install -r requirements.txt
python -m uvicorn src.financial_intelligence.api:app --reload
```

The API is available at `http://127.0.0.1:8000`; interactive API documentation is at `/docs`.

### Run the dashboard

In a second terminal:

```powershell
cd web
npm install
npm run dev
```

Open the Vite URL (normally `http://localhost:5173`). Vite proxies `/api` calls to the local FastAPI service. To build static frontend assets, run `npm run build` in `web/`.

### Firebase Authentication

The login page supports email/password registration and sign-in, Google sign-in, and GitHub sign-in through Firebase Authentication. Create a Firebase project and web app, then enable Email/Password, Google, and GitHub under **Authentication → Sign-in method**. For GitHub, create an OAuth app and enter its client ID and secret in Firebase; use the callback URL Firebase displays for that provider. Add the dashboard hostname to Firebase's authorized domains. Firebase provider secrets stay in Firebase Console and are never stored in this repository.

The Firebase web app values provided for the `finops-10a45` project are configured as defaults. To override them for another project, set these environment variables on the FastAPI process before starting it:

```powershell
$env:FINOP_FIREBASE_PROJECT_ID = "your-project-id"
$env:FINOP_FIREBASE_API_KEY = "your-web-api-key"
$env:FINOP_FIREBASE_AUTH_DOMAIN = "your-project-id.firebaseapp.com"
$env:FINOP_FIREBASE_APP_ID = "your-web-app-id"
python -m uvicorn src.financial_intelligence.api:app --reload
```

The web API key, auth domain, project ID, and app ID are public Firebase web-app configuration; the values supplied for this project are defaults and can be overridden together. Protected API routes verify Firebase ID token signatures, issuer, and audience. Firebase auth is allowed on `localhost` for development and requires HTTPS on deployed domains. The CodeBuild helper deploys an AWS-generated HTTPS CloudFront hostname; add its `DashboardDistributionDomain` output to Firebase's authorized domains after deployment. For a custom hostname, use an ACM certificate and domain. Approval is required before an action can execute; the UI asks for explicit confirmation. No financial transaction actions are supported.

### Frontend and API tests

```powershell
python -m pytest -q
cd web
npm test
npm run build
```

Existing reports appear as generated. A missing or empty Phase 6 recommendation list remains empty; the dashboard does not synthesize recommendations or financial values.

## Phase 8: AWS deployment and operations

Build and run the production image locally:

```powershell
docker build -t finop-api:local .
docker run --rm -p 8000:8000 -v finop-output:/app/output -e FINOP_API_TOKEN=replace-me finop-api:local
```

AWS infrastructure is managed with AWS CDK. Follow [the CDK deployment runbook](docs/aws-deployment.md) to bootstrap and deploy the stack. CDK creates the VPC, load balancer, ECS/Fargate service, EFS report storage, Secrets Manager secret, CloudWatch logs, and alarms. HTTPS with an ACM certificate is the default; a temporary demo can use HTTP restricted to one client IP. To deploy without local Docker, run `deploy/cdk/deploy-with-codebuild.ps1` from the repository root. No credentials belong in the repository.
