# 📺 Bingekeeper

Track your shows across streaming services and get email notifications when new episodes drop.

**Live at:** [bingekeeper.tv](https://bingekeeper.tv)

## Setup

### 1. Create D1 Database
```
npx wrangler d1 create bingekeeper-db
npx wrangler d1 execute bingekeeper-db --file=./schema.sql
```
Copy the database_id into wrangler.toml

### 2. Set secrets in Cloudflare dashboard
- `TMDB_API_KEY` — from themoviedb.org
- `JWT_SECRET` — any long random string
- `RESEND_API_KEY` — from resend.com (free)

### 3. Deploy
Push to GitHub — Cloudflare auto-deploys.
