function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

let lastRunDate = null;

// Runs all registered daily jobs once per day, after the given hour (server local time).
// Each job receives (io, now) and is awaited sequentially so jobs never overlap.
function startDailyScheduler(io, jobs, { hour = 8, intervalMs = 30 * 60 * 1000 } = {}) {
  async function tick() {
    const now = new Date();
    const today = dateKey(now);
    if (now.getHours() < hour || lastRunDate === today) return;

    // Jobs are individually idempotent (DB-level dedup per day), so a failed job
    // just gets retried on the next tick without re-sending what already succeeded.
    let allOk = true;
    for (const job of jobs) {
      try {
        await job(io, now);
      } catch (err) {
        console.error('Daily job failed:', err);
        allOk = false;
      }
    }
    if (allOk) lastRunDate = today;
  }

  tick();
  setInterval(tick, intervalMs);
}

module.exports = { startDailyScheduler };
