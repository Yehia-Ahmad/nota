import { HttpClient, HttpContext } from '@angular/common/http';
import { DestroyRef, Injectable, Injector, NgZone, computed, inject, signal } from '@angular/core';
import { environment } from '../../../environments/environment';
import { HANDLES_OWN_ERRORS } from '../auth/auth.service';
import { LockStateService } from '../auth/lock-state.service';
import { LicenseStatus, TrialBanner, trialBanner } from './trial-banner';

const TICK_MS = 30_000;
const POLL_EVERY_TICKS = 2; // a poll every minute

/**
 * Trial licenses: the state of this shop's license as the backend reports it (GET /license/status, public). A client PC asks its main PC,
 * so every PC shows the same thing. Between polls the remaining time counts down from the backend's own clock, so the banner is never
 * more than half a minute old and flips to "expired" by itself. The backend still refuses the writes; this only shows the state.
 * A lifetime license has no `trial` in the status: everything here stays empty and nothing changes.
 */
@Injectable({ providedIn: 'root' })
export class TrialStateService {
  // HttpClient is resolved only when the status is read, so a screen that merely shows the state (About card) needs no HTTP set-up.
  private readonly injector = inject(Injector);
  private readonly zone = inject(NgZone);
  private readonly lock = inject(LockStateService);

  readonly status = signal<LicenseStatus | null>(null);
  /** Backend clock minus this PC's clock, from the last answer. */
  private readonly offsetMs = signal(0);
  private readonly tick = signal(Date.now());

  /** The backend's "now", estimated between polls. */
  readonly nowMs = computed(() => this.tick() + this.offsetMs());
  readonly banner = computed<TrialBanner | null>(() => trialBanner(this.status(), this.nowMs()));
  readonly isTrial = computed(() => Boolean(this.status()?.trial));
  /** The trial ended: every write is refused (the screens disable their write buttons, the interceptor stops the rest). */
  readonly readOnly = computed(() => this.banner()?.kind === 'expired');
  /** The PC's clock went back: the backend refuses everything but the license card and sign-in. */
  readonly clockRollback = computed(() => this.banner()?.kind === 'rollback');

  private timer: ReturnType<typeof setInterval> | null = null;
  private ticks = 0;

  /** Starts the minute poll (called once by the banner in the app frame; tests that only read the state never start it). */
  start(destroyRef: DestroyRef): void {
    if (this.timer) return;
    this.refresh();
    // Outside the Angular zone: a timer that never ends must not keep a screen "unstable" (tests wait for stability). Signals update the view.
    this.timer = this.zone.runOutsideAngular(() => setInterval(() => {
      this.tick.set(Date.now());
      this.ticks += 1;
      if (this.ticks % POLL_EVERY_TICKS === 0) this.refresh();
    }, TICK_MS));
    destroyRef.onDestroy(() => this.stop());
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Asks the backend now (also after a 402 LICENSE_EXPIRED / CLOCK_ROLLBACK, so the banner follows at once). */
  refresh(): void {
    if (this.lock.locked()) return; // a locked window sends nothing new; the next poll after unlock catches up
    this.injector
      .get(HttpClient)
      .get<LicenseStatus>(`${environment.api_base_url}license/status`, { context: new HttpContext().set(HANDLES_OWN_ERRORS, true) })
      .subscribe({ next: (status) => this.apply(status), error: () => undefined });
  }

  /** Takes a status answer (also used by tests). */
  apply(status: LicenseStatus): void {
    const serverNow = status.trial?.now ? Date.parse(status.trial.now) : NaN;
    this.tick.set(Date.now());
    this.offsetMs.set(Number.isNaN(serverNow) ? 0 : serverNow - Date.now());
    this.status.set(status);
  }
}
