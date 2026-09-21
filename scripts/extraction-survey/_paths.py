"""Where the survey reads its inputs and writes its outputs.

Nothing generated is kept beside these scripts. This directory is tracked; the
survey's intermediates are large, regenerable from the document cache, and
`.gitignore` covers `.extraction-survey/` for exactly them. The repo root is
derived from this file, so a checkout at any path works and no script carries an
absolute one.

Set OPENCOUNCIL_SURVEY_DIR to keep the intermediates somewhere else.
"""
import os

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(SCRIPTS))
WORK = os.environ.get("OPENCOUNCIL_SURVEY_DIR") or os.path.join(ROOT, ".extraction-survey")
FIXTURES = os.path.join(ROOT, "fixtures")


def work(name):
    """An intermediate: read from, and written to, the gitignored work directory."""
    return os.path.join(WORK, name)


def fixture(name):
    """A committed fixture under fixtures/."""
    return os.path.join(FIXTURES, name)


def script(name):
    """A tracked file beside the scripts, such as an HTML template."""
    return os.path.join(SCRIPTS, name)
