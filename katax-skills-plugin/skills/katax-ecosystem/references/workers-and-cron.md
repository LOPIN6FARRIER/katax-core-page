# Workers, cron and background jobs

Background work lives outside controllers, in `src/workers/` (heavy processing) and `src/jobs/` (scheduled
tasks). It calls services and repositories like a controller does and never writes SQL itself.

## Layout

```
src/
├── workers/variants.worker.ts      # image thumbnails / video frames (sharp, ffmpeg)
├── jobs/sessions-cleanup.job.ts    # one scheduled task per file
├── jobs/index.ts                   # registers every job with katax.cron (called from index.ts)
└── services/cleanup.service.ts     # the logic the jobs call (repositories underneath)
```

## Registering jobs

```ts
// jobs/index.ts
import { katax } from 'katax-service-manager';
import { runExclusive } from '../shared/job-lock.utils.js';
import * as sessionsRepository from '../api/auth/sessions.repository.js';
import { purgeExpiredTrash } from '../services/trash.service.js';

export async function registerJobs(): Promise<void> {
  await katax.cron({
    name: 'sessions-cleanup',
    schedule: '15 3 * * *',
    timezone: 'America/Mexico_City',
    task: () => runExclusive('sessions-cleanup', () => sessionsRepository.deleteExpiredSessions(30))
  });
  await katax.cron({
    name: 'trash-purge',
    schedule: '0 * * * *',
    task: () => runExclusive('trash-purge', purgeExpiredTrash)
  });
}
```

- **`runExclusive`** (`assets/templates/shared/job-lock.utils.ts`): every PM2 instance fires the same schedule,
  and old and new processes overlap during `pm2 reload`. The advisory lock lets one run and the rest skip. It also
  logs duration and errors, so a failing job never crashes the API.
- **One unique name per job**; `katax.cronService.getJobs()` shows them.
- **Idempotent work**: a run interrupted halfway must be safe to repeat (delete by condition, not by a list
  computed in memory an hour ago; process in batches with `LIMIT`).
- **Retention jobs** for anything that grows without bound: expired sessions, trash past its window, activity
  logs, expired shares and one-time codes.

## Workers (heavy processing)

- Limits are visible constants (`MAX_THUMB_SIDE = 4096`, max frame size, quality) and inputs that become file
  names or sizes are revalidated before touching disk, even if the request schema already checked them: this is
  the boundary with the filesystem.
- A request that triggers heavy work either waits for a bounded synchronous step (a resize) or enqueues the job and
  returns 202; it never runs unbounded work inline.
- Writes the result through a repository (`variantsRepository.saveVariant(...)`).

## Prohibited

- SQL in a service, worker or job (`db.query(...)` on a raw connection): move it to a repository so ownership,
  columns and transactions follow the same rules as everywhere else.
- `setInterval` loops instead of `katax.cron` (no name, no visibility, no shutdown).
- A job without `runExclusive` when the app can run with more than one instance.
