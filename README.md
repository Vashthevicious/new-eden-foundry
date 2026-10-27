# New Eden Foundry

EVE Online production calculator. Full industry chains — capital production,
T2/T3 invention and manufacturing, moon-goo reactions, component builds — with
live Jita prices and your own researched blueprints via ESI.

**No server.** Everything runs in the browser; plans, stock, prices and tokens
stay in your browser's local storage.

## Features

- Recursive bill of materials with **build / buy control at every tier** — stop
  any chain where you want and that tier moves to the shopping list
- Stockpile: declare materials you already own at any tier; demand is netted
- Tiered production steps (reactions → components → final) with run counts and
  job times
- Invention: expected attempts, datacores, consumed relics (T3)
- Live Jita buy/sell from Fuzzwork market aggregates, ESI universe averages as
  fallback, manual overrides inline
- EVE SSO (PKCE): log in to apply your real blueprint ME/TE automatically
- Production flow map per target, item icons and ship renders from CCP's image
  server

## Hosting (GitHub Pages)

Repo → Settings → Pages → Deploy from branch → `main`, root. Done.

## ESI login setup (one time)

1. Create an application at <https://developers.eveonline.com/applications>
   - type: Authentication & API access
   - scope: `esi-characters.read_blueprints.v1`
   - callback URL: your Pages URL exactly (e.g. `https://<user>.github.io/new-eden-foundry/`)
2. Paste the application's Client ID into the **Prices · Stock · ESI** tab.
3. Log in with EVE. Tokens never leave your browser.

## Data

Static data extracted from the EVE SDE (CCP's official export) into
`data/types.json` and `data/recipes.json`. To update for a new SDE release,
re-run the extraction against `fsd/blueprints.yaml`, `fsd/types.yaml`,
`fsd/groups.yaml`, `fsd/categories.yaml`.

Material formula per job: `max(runs, ceil(base × runs × (1−ME/100) × (1−structure/100)))`;
reactions take the reaction-structure bonus only. Not modeled: system cost
indices/taxes, decryptors, invention skill bonuses, PI schematics.

EVE Online and all related imagery are the property of [CCP hf](https://www.ccpgames.com/).
This is a fan-made tool under CCP's third-party developer license.
