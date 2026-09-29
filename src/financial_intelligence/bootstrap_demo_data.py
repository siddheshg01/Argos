"""Seed an empty persistent report volume with the bundled public demo dataset."""
from pathlib import Path
import logging

from .pipeline import FinancialIntelligencePipeline
from .root_cause import RootCauseInvestigator

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "output"
DEMO_DATASET = ROOT / "data" / "sample_superstore.csv"
logger = logging.getLogger(__name__)


def main() -> None:
    """Generate initial dashboard reports only when the persistent volume is empty."""
    if (OUTPUT / "financial_report.json").is_file():
        logger.info("Financial report already exists; keeping the workspace dataset.")
        return
    if not DEMO_DATASET.is_file():
        raise FileNotFoundError(f"Bundled demo dataset is missing: {DEMO_DATASET}")
    logger.info("No financial report found; generating reports from the public Sample Superstore dataset.")
    FinancialIntelligencePipeline(DEMO_DATASET, OUTPUT).run()
    RootCauseInvestigator(DEMO_DATASET, output_dir=OUTPUT).run()
    forecast_ready = False
    try:
        from .forecasting import FinancialForecaster
        FinancialForecaster(DEMO_DATASET, output_dir=OUTPUT).run()
        forecast_ready = True
    except Exception:
        logger.exception("Sample Superstore financial report is ready, but forecasting could not be generated.")
    logger.info("Sample Superstore Phase 1-2 reports are ready; forecast report ready=%s.", forecast_ready)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    main()
