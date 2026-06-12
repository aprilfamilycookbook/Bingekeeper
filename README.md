# Bingekeeper

Track TV shows across streaming services and get email notifications when new episodes drop.

Live domain: https://bingekeeper.tv

## Local Setup

Install the project dependency:

```sh
npm install
```

Create a local development secrets file:

```sh
cp .dev.vars.example .dev.vars
```

Then fill in:

- `TMDB_API_KEY`
- `JWT_SECRET`
- `RESEND_API_KEY`

Run locally:

```sh
npm run dev
```

## Cloudflare Setup

This repo deploys as a Cloudflare Worker with static assets.

- Worker name: `bingekeeper`
- D1 database: `bingekeeper-db`
- D1 binding: `DB`
- Assets directory: `src/public`
- Scheduled notification check: daily at 10:00 UTC

Apply the database schema:

```sh
npm run db:schema
```

Deploy:

```sh
npm run deploy
```

## GitHub Deploys

The workflow in `.github/workflows/deploy.yml` deploys pushes to `main` with Wrangler.

Add these GitHub Actions secrets before relying on automatic deploys:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

## Notes

The current Cloudflare Worker has a TMDB secret named `TMDB_API_KEY ` with a trailing space. The Worker code supports both `TMDB_API_KEY` and `TMDB_API_KEY ` so the existing deployment keeps working, but the clean long-term fix is to recreate that secret as `TMDB_API_KEY`.

The live D1 database originally had an older schema. It was updated on 2026-06-12 to add the `users.name`, `users.verified`, `users.verify_token`, `users.reset_token`, `users.reset_expires`, `watchlist.current_season`, `watchlist.current_episode`, and `watchlist.notify` columns required by the current Worker.
