"""Self-contained clients for Tier 2 sources.

These exist so the sync doesn't depend on scraper libraries that download binaries at
import time or drag in browser automation — both of which break in CI. See
`sofascore.py`'s module docstring for the concrete case.
"""
