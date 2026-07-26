"""Cross-source identity resolution.

Teams are a hand-curated alias map (20 clubs, changing once a year — see `teams.py` for
why fuzzy matching would be strictly worse). Players are a cascading name matcher whose
results are persisted to `player_external_ids` and reused, so a manual correction sticks.
"""

from .players import FplPlayer, Match, PlayerResolver
from .teams import TeamResolver

__all__ = ["FplPlayer", "Match", "PlayerResolver", "TeamResolver"]
