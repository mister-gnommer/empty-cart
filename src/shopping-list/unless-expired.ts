// Budget-bounded waiting shared by recognition and the AI sorting step.

export const BUDGET_EXPIRED = Symbol('budget-expired');

/**
 * Settles with the work's outcome, or with BUDGET_EXPIRED as soon as the
 * budget signal fires. A callee that ignores the signal is abandoned rather
 * than awaited, so it can never wedge the submission or its busy-guard entry.
 * @param work the download, recognition or categorization to wait for
 * @param budgetExpiry fires when the time budget runs out
 */
export function unlessExpired<T>(
  work: Promise<T>,
  budgetExpiry: AbortSignal,
): Promise<T | typeof BUDGET_EXPIRED> {
  // The abort listener stays when `work` wins; harmless, as the signal lives for one submission.
  const expired = new Promise<typeof BUDGET_EXPIRED>((resolve) => {
    if (budgetExpiry.aborted) {
      resolve(BUDGET_EXPIRED);
    }
    budgetExpiry.addEventListener('abort', () => resolve(BUDGET_EXPIRED), { once: true });
  });
  // `expired` goes first so an already-aborted budget wins. race subscribes to
  // `work`, so a late rejection from abandoned work is never unhandled.
  return Promise.race([expired, work]);
}
