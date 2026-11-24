import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, effect, inject } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { AuthService } from '../auth/auth.service';
import { ToastService } from '../auth/toast.service';
import { ReadOnlyUi } from './read-only-ui';
import { TrialStateService } from './trial-state.service';

/**
 * Trial licenses: the full-width banner at the top of the app, and the owner of the "view-only" state of the screens.
 *   countdown  "نسخة تجريبية — فاضل N يوم / ساعة / دقيقة" for every signed-in user (red in the last 3 days, always red for a short trial);
 *              the owner also sees the phone number for the full license.
 *   expired    "انتهت النسخة التجريبية — البرنامج للعرض بس" (also before sign-in), and the write buttons are disabled.
 *   rollback   "ساعة الجهاز متأخرة — صلّحها وافتح البرنامج تاني"
 * Nothing shows for a lifetime license.
 */
@Component({
  selector: 'app-trial-banner',
  imports: [TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (shown(); as banner) {
      <div class="trial" [class.trial--red]="banner.red" [attr.data-kind]="banner.kind" role="status" data-test="trial-banner">
        <span data-field="trial-banner-text">{{ ('trial.banner.' + (banner.kind === 'countdown' ? banner.unit : banner.kind)) | translate: { n: banner.n } }}</span>
        @if (banner.kind === 'countdown' && isOwner()) {
          <span class="trial__owner" data-field="trial-banner-owner">{{ 'trial.banner.owner' | translate }}</span>
        }
      </div>
    }
  `,
  styles: `
    :host { display: block; position: sticky; top: 0; z-index: 60; }
    .trial { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px 16px; width: 100%; padding: 8px 16px; font-weight: 700; font-size: 14px; background: var(--warning-soft, #fff4d6); color: var(--warning-text, #7a5200); border-bottom: 1px solid var(--border, #ddd); }
    .trial--red { background: var(--danger-soft, #fde2e2); color: var(--danger-text, #8f1d1d); }
    .trial__owner { font-weight: 600; }
  `,
})
export class TrialBannerComponent implements OnInit {
  private readonly state = inject(TrialStateService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly doc = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private readonly readOnlyUi = new ReadOnlyUi(this.doc, () => this.toast.error(this.translate.instant('trial.readOnlyAction')));

  protected readonly isOwner = computed(() => this.auth.user()?.role === 'owner');
  /** The countdown needs a signed-in user; the expired and clock messages show to everyone, even on the sign-in screen. */
  protected readonly shown = computed(() => {
    const banner = this.state.banner();
    if (!banner) return null;
    return banner.kind === 'countdown' && !this.auth.signedIn() ? null : banner;
  });

  constructor() {
    effect(() => (this.state.readOnly() ? this.readOnlyUi.enable() : this.readOnlyUi.disable()));
    this.destroyRef.onDestroy(() => this.readOnlyUi.disable());
  }

  ngOnInit(): void {
    this.state.start(this.destroyRef);
  }
}
