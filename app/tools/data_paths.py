"""Static catalogs stay in the image; APP_DATA_DIR holds persistent user records."""

import os
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
STATIC_DB = ROOT / "app" / "db"
DATA_DB = Path(os.environ.get("APP_DATA_DIR") or STATIC_DB).expanduser().resolve()
MUTABLE_NAMES = (
    "users", "user_specializations", "user_names", "user_tests", "user_fsp",
    "companies", "user_project_company", "projects_jobopenings", "invitations", "user_blocks",
)


def mutable_dir(name):
    return DATA_DB / name


def initialize_data():
    for name in MUTABLE_NAMES:
        mutable_dir(name).mkdir(parents=True, exist_ok=True)
    # Preserve existing companies while installing the initial company catalog once.
    if DATA_DB != STATIC_DB:
        for source in (STATIC_DB / "companies").glob("*.json"):
            target = mutable_dir("companies") / source.name
            if not target.exists():
                shutil.copyfile(source, target)
