// The UPLOADER: sends waiting sales one at a time, oldest first, and decides what each answer means.
// Pure logic (the "send" function is passed in), so it is tested in Node with a pretend server.

/**
 * network   = could not reach the server (or it is down for a moment): keep everything, try again later
 * auth      = the sign-in has expired: keep everything, ask for sign-in
 * business  = the server understood and said no (product gone, not allowed...): park it as "needs attention"
 */
export function classifyError(error) {
  const m = String(error?.message || error || '');
  if (/cannot reach the server|failed to fetch|networkerror|load failed|network request failed|timed out|timeout|bad gateway|service unavailable|gateway time-?out|\b50[234]\b|too many connections|deadlock detected|could not serialize|statement timeout|connection (reset|refused|closed)|fetch failed|aborted/i.test(m)) return 'network';
  if (/sign-in has expired|jwt expired|invalid jwt|not authenticated|refresh token|session (expired|missing)/i.test(m)) return 'auth';
  return 'business';
}

export function createSync({ outbox, send, getUserId }) {
  let running = false;
  return {
    get running() { return running; },
    /** Upload everything that is waiting for the signed-in person. Returns what happened. */
    async run() {
      if (running) return { skipped: true, sent: 0 };
      running = true;
      let sent = 0; let failed = 0; const results = [];
      try {
        const user = getUserId();
        if (!user) return { sent, failed, stopped: 'signed-out' };
        const list = (await outbox.all()).filter((e) => e.status === 'waiting' && e.userId === user);
        for (const e of list) {
          try {
            const res = await send(e);
            await outbox.markDone(e.id, res);
            results.push({ id: e.id, invoice: res?.invoice_number, duplicate: !!res?.duplicate });
            sent += 1;
          } catch (err) {
            const kind = classifyError(err);
            if (kind === 'network') { await outbox.noteAttempt(e.id, err.message); return { sent, failed, stopped: 'network', results }; }
            if (kind === 'auth') { await outbox.noteAttempt(e.id, err.message); return { sent, failed, stopped: 'auth', results }; }
            await outbox.markFailed(e.id, err.message);
            failed += 1;
          }
        }
        return { sent, failed, results };
      } finally { running = false; }
    },
  };
}
