/**
 * Trial licenses: what the banner says. Pure functions, so the rules are tested without a screen.
 * The backend decides what is allowed (402 LICENSE_EXPIRED / CLOCK_ROLLBACK); this only shows it.
 */

/** What GET /api/license/status answers. `type` and `trial` are present only for a trial license. */
export interface LicenseStatus {
  licensed: boolean;
  code?: string | null;
  shopName?: string | null;
  type?: 'trial';
  expiresAt?: string;
  trial?: {
    state: 'active' | 'expired' | 'clock-rollback';
    issuedAt: string;
    expiresAt: string;
    remainingMs: number;
    /** The backend's clock when it answered. */
    now: string;
  };
}

export type TrialBannerKind = 'countdown' | 'expired' | 'rollback';
export type RemainingUnit = 'days' | 'hours' | 'minutes';

export interface TrialBanner {
  kind: TrialBannerKind;
  /** countdown only */
  unit?: RemainingUnit;
  n?: number;
  /** Red: the last 3 days, any trial shorter than 3 days, expired and clock rollback. */
  red: boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "N days" from a day up, "N hours" under 24 hours, "N minutes" under an hour (rounded up, never 0 while time is left). */
export function remainingParts(remainingMs: number): { unit: RemainingUnit; n: number } {
  const ms = Math.max(0, remainingMs);
  if (ms >= DAY) return { unit: 'days', n: Math.ceil(ms / DAY) };
  if (ms >= HOUR) return { unit: 'hours', n: Math.ceil(ms / HOUR) };
  return { unit: 'minutes', n: Math.max(1, Math.ceil(ms / MINUTE)) };
}

/**
 * The banner for a status at `nowMs` (the backend's clock, estimated between polls), or null when there is nothing to show
 * (no trial). Time is checked against `nowMs`, so the banner turns "expired" by itself when the end passes.
 */
export function trialBanner(status: LicenseStatus | null, nowMs: number): TrialBanner | null {
  const trial = status?.trial;
  if (!status?.licensed || !trial) return null;
  if (trial.state === 'clock-rollback') return { kind: 'rollback', red: true };
  const expiresMs = Date.parse(trial.expiresAt);
  const remaining = expiresMs - nowMs;
  if (trial.state === 'expired' || remaining <= 0) return { kind: 'expired', red: true };
  const total = expiresMs - Date.parse(trial.issuedAt);
  const red = remaining <= 3 * DAY || total < 3 * DAY;
  return { kind: 'countdown', ...remainingParts(remaining), red };
}

/** Writes that still work after the trial ended: the same short list the backend keeps (license/middleware.js). */
const EXEMPT_WRITES = /\/(auth\/(login|logout|refresh|change-password|verify-password|recover)|license\/activate|print\/(reserve|confirm|release))\/?$/;

/** True for a request the read-only state must stop: not a read, and not on the exempt list. */
export function isBlockedWhenReadOnly(method: string, url: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  return !EXEMPT_WRITES.test(url.split('?')[0]);
}

/**
 * The buttons that write something, by their data-action (the screens already name them). Disabled while the trial is over. Everything
 * else (search, filters, print, export, statements, close-dialog buttons) stays usable; a write without a name here is still refused
 * by the interceptor with a message, so nothing fails silently.
 */
const WRITE_ACTION =
  /^(save|confirm-|do-|new-|add-|create-|post$|pay$|collect$|credit-apply$|credit-payout$|apply-save$|payout-save$|invoice-payment$|opening-collect-save$|open-shift$|close-shift$|close$|file$|unfile$|finalize|reopen$|reverse$|deactivate$|reactivate$|delete|cancel-expense$|edit|toggle-status$|toggle-category$|unpair$|allow$|import-|remove-line$|drawing$|transfer$|return$|sync-purchase-price$|bulk-barcodes$)/;

/** True when this element is a button/link that writes data (see WRITE_ACTION), or a delete/cancel-style danger button. */
export function isWriteControl(element: Element): boolean {
  const action = element.getAttribute('data-action');
  if (action && WRITE_ACTION.test(action)) return true;
  return element.matches('button[notaButton="danger"]');
}
