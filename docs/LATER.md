Wishlist for Later

1. [DONE 2026-07-28 — one delegated host; 8 445 table cells get value + rank + why] Custom tooltip with more details. 
2. More "analysis explanation". You should target Brentford now because their current trend is that they are not conceding shots. They have started season well etc. And other examples.
3. [DONE 2026-07-28 — components/team-badge.tsx, keyed on teams.code, SVG] Implement team logo badges. I.e this is Everton (team Code = 11): https://resources.premierleague.com/premierleague25/badges/11.svg
4. [DONE 2026-07-27 — /teams scatter + chart mode on /players] Would be cool to view some graphics. I.e I love the X, Y scatter plots with i.e expected goals on X axis and then expected  goals against on Y axis. And then each team is a dot. I love those both for teams and players. So would be great to have this. Also would need your help deciding which ones are useful. 
5. Analyse this page:https://allaboutfpl.com to see if we can learn something. 
6. [DONE 2026-07-28 — components/player-identity.tsx, replaced five copies] One common player component (Photo, title, subtitle, position, club, upcoming opponent). Think Watchlist and Captain on dashboard + Players table (first column). For reuse and scalabiluity maybe it makes sense to merge into one shared component?
7. [DONE 2026-07-28 — plus /prices, which was also a dead end] Redirect from Dashboard, Hidden Gems and Teams page to Player/Team profile page.
8. [DONE 2026-07-28 — object-position 50% 15% + scale(1.6); the sources are torso portraits, not face shots] Player-photo is not contained inside circle. it actually looks like it's on top of the circle, not inside. 
9. Optimise for mobile responsiveness.
10. Login with FPL to get current team (before GW deadline). **Checked 2026-07-29 — the premise
    needs correcting: there is no "Log in with FPL" a third party can implement.**
    `users.premierleague.com`, the email+password POST that every guide and every Python library
    (`fpl`, `fpl-cli`) still documents, **no longer resolves in DNS**. Login moved to
    `account.premierleague.com`, a CNAME to `edge1.pingone.eu` — PingOne hosted OIDC, no public
    client registration, so there is no consent screen to integrate against. Add optional
    authenticator-app 2FA (live since 2024-07-01), which kills any headless password flow, and
    the PL's stated position: "We have never condoned or endorsed the use of third-party websites
    or applications to aid FPL team management."

    The squad endpoints, probed against entry 1617827: `my-team/{id}/` → **403**
    `{"detail":"Authentication credentials were not provided."}` — a plain DRF gate, so a session
    cookie is still the whole mechanism and there is no bot wall; `me/` → 200 with `player: null`,
    which makes it the cheap "are my credentials still live" probe; `entry/{id}/` → 200;
    `entry/{id}/event/1/picks/` → 404 until the GW1 deadline, as `sync/jobs/manager.py` already
    documents.

    **Fantasy Football Fix does not do this server-side either**, which is the part worth knowing.
    Linking by FPL ID is free and credential-free but "will not upload your latest squad transfers
    onto the website, it will only upload your squad from the previous gameweek" — that is just the
    public `picks` endpoint. The *latest* squad only reaches them if you "reload your squad using
    the free mobile app or free browser extension, FPL Plus", where the FPL password "is only used
    locally on your device and is not sent to the server"; before GW1 they fall back to a
    **screenshot upload**. So the roughly-monthly login is Fix's own session expiring, not FPL
    granting Fix access to the team — the authenticated call happens on the user's device, and a
    paid product still has no server-side route to a pre-deadline squad.

    That splits this wish in two, and only the second half is hard:
    - **From the GW1 deadline onward, no auth is needed at all.** `entry_picks_optional` already
      fetches `picks` and `managers`/`manager_seasons` are already synced, so "see my team" is a
      page, not an integration. Do this one.
    - **The pre-deadline delta** — transfers queued but not yet locked — is the only thing auth
      buys, and it is worth ~one gameweek of staleness. Cheapest honest option if it ever matters:
      paste the `pl_profile` + `sessionid` cookies out of a browser already logged in, keep them
      local-only, and call `my-team/` from a local run — never from Actions, never in Postgres.
      Otherwise type the 15 players in once before GW1, which is all the screenshot upload is.
      Do **not** store FPL credentials server-side.
11. Email integration with Resend to send emails daily with updates (price changes, "your team is not updated" etc). NOT NOW I will inform.
12. [DONE 2026-07-29 — three-state Auto/Light/Dark in the header; the tokens were already there, the toggle wasn't] Dark Mode