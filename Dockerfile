FROM node:22-alpine AS frontend
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8000
WORKDIR /app
RUN groupadd --system finop && useradd --system --gid finop --home-dir /app finop
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY src/ ./src/
COPY data/knowledge_base/ ./data/knowledge_base/
COPY data/sample_superstore.csv ./data/sample_superstore.csv
COPY --from=frontend /build/web/dist/ ./web/dist/
RUN mkdir -p output data/processed && chown -R finop:finop /app
USER finop
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.getenv('PORT','8000')+'/api/ready',timeout=3)"
CMD ["sh", "-c", "python -m src.financial_intelligence.bootstrap_demo_data && uvicorn src.financial_intelligence.api:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers"]
