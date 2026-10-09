"""Static catalogs stay in the image; APP_DATA_DIR holds persistent user records."""

import json
import os
import shutil
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
STATIC_DB = ROOT / "app" / "db"
DATA_DB = Path(os.environ.get("APP_DATA_DIR") or STATIC_DB).expanduser().resolve()
MUTABLE_NAMES = (
    "users", "user_specializations", "user_names", "user_tests", "user_fsp",
    "companies", "user_project_company", "projects_jobopenings", "invitations", "user_blocks",
)
SEED_LEDGER_NAME = ".seed-imports.json"


def mutable_dir(name):
    return DATA_DB / name


def _load_seed_ledger(path):
    if not path.exists():
        return set()
    with path.open(encoding="utf-8") as stream:
        ledger = json.load(stream)
    if (
        not isinstance(ledger, dict)
        or ledger.get("version") != 1
        or not isinstance(ledger.get("imported"), list)
        or not all(isinstance(record, str) for record in ledger["imported"])
    ):
        raise ValueError("Invalid seed import ledger")
    return set(ledger["imported"])


def _copy_seed_if_missing(source, target):
    if target.exists():
        return
    # Publish only a complete copy; a failed copy must never become a user record.
    with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            with source.open("rb") as original:
                shutil.copyfileobj(original, stream)
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            stream.close()
            temporary.unlink(missing_ok=True)
            raise
    try:
        # Unlike replace(), link() cannot overwrite a concurrently created record.
        os.link(temporary, target)
    except FileExistsError:
        pass
    finally:
        temporary.unlink(missing_ok=True)


def _save_seed_ledger(path, imported):
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, delete=False
    ) as stream:
        temporary = Path(stream.name)
        try:
            json.dump({"version": 1, "imported": sorted(imported)}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            stream.close()
            temporary.unlink(missing_ok=True)
            raise
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def initialize_data():
    for name in MUTABLE_NAMES:
        mutable_dir(name).mkdir(parents=True, exist_ok=True)
    if DATA_DB == STATIC_DB:
        return
    ledger_path = DATA_DB / SEED_LEDGER_NAME
    imported = _load_seed_ledger(ledger_path)
    updated = set(imported)
    for name in MUTABLE_NAMES:
        for source in sorted((STATIC_DB / name).glob("*.json")):
            record = f"{name}/{source.name}"
            if record not in imported:
                _copy_seed_if_missing(source, mutable_dir(name) / source.name)
                updated.add(record)
    if updated != imported:
        _save_seed_ledger(ledger_path, updated)
