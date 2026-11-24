import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { authInterceptor } from '../auth/auth.interceptor';
import { AuthService } from '../auth/auth.service';
import { ToastService } from '../auth/toast.service';
import { signInAs } from '../auth/testing/sign-in';
import { ReadOnlyUi } from './read-only-ui';
import { TrialBannerComponent } from './trial-banner.component';
import { LicenseStatus, isBlockedWhenReadOnly, isWriteControl, remainingParts, trialBanner } from './trial-banner';
import { TrialStateService } from './trial-state.service';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-06-01T12:00:00.000Z');

const status = (over: Partial<NonNullable<LicenseStatus['trial']>> & { issuedAt?: string } = {}, expiresInMs = 10 * DAY, issuedAgoMs = 5 * DAY): LicenseStatus => ({
  licensed: true,
  type: 'trial',
  expiresAt: new Date(NOW + expiresInMs).toISOString(),
  trial: {
    state: 'active',
    issuedAt: new Date(NOW - issuedAgoMs).toISOString(),
    expiresAt: new Date(NOW + expiresInMs).toISOString(),
    remainingMs: expiresInMs,
    now: new Date(NOW).toISOString(),
    ...over,
  },
});

describe('trial banner rules (trialBanner)', () => {
  it('days: "N days" from 24 hours up, rounded up; hours under 24 hours; minutes under an hour', () => {
    expect(remainingParts(30 * DAY)).toEqual({ unit: 'days', n: 30 });
    expect(remainingParts(2 * DAY + 1)).toEqual({ unit: 'days', n: 3 });
    expect(remainingParts(DAY)).toEqual({ unit: 'days', n: 1 });
    expect(remainingParts(DAY - 1)).toEqual({ unit: 'hours', n: 24 });
    expect(remainingParts(5 * HOUR)).toEqual({ unit: 'hours', n: 5 });
    expect(remainingParts(HOUR)).toEqual({ unit: 'hours', n: 1 });
    expect(remainingParts(HOUR - 1)).toEqual({ unit: 'minutes', n: 60 });
    expect(remainingParts(10 * MIN)).toEqual({ unit: 'minutes', n: 10 });
    expect(remainingParts(1)).toEqual({ unit: 'minutes', n: 1 });
  });

  it('a lifetime license (no trial in the status) and no status show no banner', () => {
    expect(trialBanner(null, NOW)).toBeNull();
    expect(trialBanner({ licensed: true }, NOW)).toBeNull();
    expect(trialBanner({ licensed: false, code: 'NO_LICENSE' }, NOW)).toBeNull();
  });

  it('countdown is red only in the last 3 days, or always for a trial shorter than 3 days', () => {
    expect(trialBanner(status({}, 10 * DAY, 20 * DAY), NOW)).toEqual({ kind: 'countdown', unit: 'days', n: 10, red: false });
    expect(trialBanner(status({}, 4 * DAY, 26 * DAY), NOW)?.red).toBeFalse();
    expect(trialBanner(status({}, 3 * DAY, 27 * DAY), NOW)?.red).toBeTrue();
    expect(trialBanner(status({}, 2 * DAY, 28 * DAY), NOW)?.red).toBeTrue();
    // a 1-day trial and a 1-hour trial are red from the first minute
    expect(trialBanner(status({}, DAY - MIN, MIN), NOW)).toEqual({ kind: 'countdown', unit: 'hours', n: 24, red: true });
    expect(trialBanner(status({}, HOUR - MIN, MIN), NOW)).toEqual({ kind: 'countdown', unit: 'minutes', n: 59, red: true });
    // a 7-day trial is not red on day 1
    expect(trialBanner(status({}, 7 * DAY - MIN, MIN), NOW)?.red).toBeFalse();
  });

  it('expired (by the backend state, or because the end passed since the last answer) and clock rollback are red messages', () => {
    expect(trialBanner(status({ state: 'expired', remainingMs: 0 }, -DAY), NOW)).toEqual({ kind: 'expired', red: true });
    expect(trialBanner(status({}, 5 * MIN), NOW + 6 * MIN)).toEqual({ kind: 'expired', red: true });
    expect(trialBanner(status({ state: 'clock-rollback' }), NOW)).toEqual({ kind: 'rollback', red: true });
  });

  it('the exempt writes match the backend list; everything else that is not a read is blocked', () => {
    const base = environment.api_base_url;
    for (const exempt of ['auth/login', 'auth/logout', 'auth/refresh', 'auth/change-password', 'auth/recover', 'license/activate', 'print/reserve', 'print/confirm', 'print/release']) {
      expect(isBlockedWhenReadOnly('POST', `${base}${exempt}`)).withContext(exempt).toBeFalse();
    }
    for (const blocked of [['POST', 'sellings'], ['PUT', 'shop-profile'], ['DELETE', 'products/1'], ['PATCH', 'users/1/status'], ['POST', 'customers/1/payouts'], ['POST', 'license/clients/x/allow']]) {
      expect(isBlockedWhenReadOnly(blocked[0], `${base}${blocked[1]}`)).withContext(blocked.join(' ')).toBeTrue();
    }
    expect(isBlockedWhenReadOnly('GET', `${base}sellings`)).toBeFalse();
    expect(isBlockedWhenReadOnly('HEAD', `${base}sellings`)).toBeFalse();
  });
});

describe('trial banner screen and read-only state', () => {
  const base = environment.api_base_url;
  let http: HttpTestingController;
  let state: TrialStateService;
  let fixture: ReturnType<typeof TestBed.createComponent<TrialBannerComponent>>;
  const el = () => fixture.nativeElement as HTMLElement;
  const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
  const text = () => el().querySelector('[data-field="trial-banner-text"]')?.textContent?.trim();

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TrialBannerComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideHttpClient(withInterceptors([authInterceptor])), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('ar', {
      trial: {
        readOnlyAction: 'للعرض بس',
        banner: {
          days: 'نسخة تجريبية — فاضل {{n}} يوم', hours: 'نسخة تجريبية — فاضل {{n}} ساعة', minutes: 'نسخة تجريبية — فاضل {{n}} دقيقة',
          owner: 'كلّم 01028647164 للرخصة الكاملة', expired: 'انتهت النسخة التجريبية — البرنامج للعرض بس', rollback: 'ساعة الجهاز متأخرة — صلّحها وافتح البرنامج تاني',
        },
      },
    });
    translate.use('ar');
    state = TestBed.inject(TrialStateService);
    TestBed.inject(AuthService).clear();
  });
  afterEach(() => { fixture?.destroy(); document.documentElement.classList.remove('nota-readonly'); });

  const show = async (s: LicenseStatus) => {
    fixture = TestBed.createComponent(TrialBannerComponent);
    fixture.detectChanges();
    http.expectOne(`${base}license/status`).flush(s);
    await settle();
  };

  it('says nothing for a lifetime license, and the countdown needs a signed-in user', async () => {
    await show({ licensed: true });
    expect(el().querySelector('[data-test="trial-banner"]')).toBeNull();
    state.apply(status());
    await settle();
    expect(el().querySelector('[data-test="trial-banner"]')).toBeNull(); // not signed in
    signInAs('cashier');
    await settle();
    expect(text()).toBe('نسخة تجريبية — فاضل 10 يوم');
  });

  it('days, hours and minutes texts; the owner also sees the phone number, a cashier does not', async () => {
    signInAs('cashier');
    await show(status({}, 12 * DAY, 18 * DAY));
    expect(text()).toBe('نسخة تجريبية — فاضل 12 يوم');
    expect(el().querySelector('[data-field="trial-banner-owner"]')).toBeNull();
    expect(el().querySelector('.trial--red')).toBeNull();

    state.apply(status({}, 5 * HOUR, 2 * DAY));
    await settle();
    expect(text()).toBe('نسخة تجريبية — فاضل 5 ساعة');
    expect(el().querySelector('.trial--red')).not.toBeNull();

    state.apply(status({}, 20 * MIN, 2 * DAY));
    await settle();
    expect(text()).toBe('نسخة تجريبية — فاضل 20 دقيقة');

    signInAs('owner');
    await settle();
    expect(el().querySelector('[data-field="trial-banner-owner"]')?.textContent?.trim()).toBe('كلّم 01028647164 للرخصة الكاملة');
  });

  it('expired: a red full-width message for everyone (even signed out), and write buttons are disabled while reads stay enabled', async () => {
    const host = document.createElement('div');
    host.innerHTML = `
      <button data-action="save-product" id="w1">حفظ</button>
      <button notaButton="danger" id="w2">حذف</button>
      <button data-action="export-products" id="r1">تصدير</button>
      <button data-action="print-invoice" id="r2">طباعة</button>
      <button data-action="apply-filters" id="r3">بحث</button>
      <button data-action="activate-license" id="r4">تفعيل</button>
      <a data-action="new-purchase" id="w3">+ فاتورة</a>`;
    document.body.appendChild(host);
    try {
      await show(status({ state: 'expired', remainingMs: 0 }, -HOUR, 31 * DAY));
      expect(text()).toBe('انتهت النسخة التجريبية — البرنامج للعرض بس');
      expect(el().querySelector('.trial--red')).not.toBeNull();
      expect(el().querySelector('[data-kind="expired"]')).not.toBeNull();
      const btn = (id: string) => host.querySelector(`#${id}`) as HTMLButtonElement;
      expect(btn('w1').disabled).toBeTrue();
      expect(btn('w2').disabled).toBeTrue();
      for (const id of ['r1', 'r2', 'r3', 'r4']) expect(btn(id).disabled).withContext(id).toBeFalse();
      // a write link cannot be disabled: its click is stopped and explained
      let reached = false;
      host.querySelector('#w3')!.addEventListener('click', () => (reached = true));
      (host.querySelector('#w3') as HTMLElement).click();
      expect(reached).toBeFalse();
      expect(TestBed.inject(ToastService).toasts().some((toast) => toast.text === 'للعرض بس')).toBeTrue();
      // a dialog that opens later gets the same treatment
      const late = document.createElement('button');
      late.setAttribute('data-action', 'confirm-save');
      host.appendChild(late);
      await new Promise((resolve) => setTimeout(resolve));
      expect(late.disabled).toBeTrue();
      // the license replaced: everything is enabled again
      state.apply({ licensed: true });
      // (no whenStable here: the toast above keeps a 5 s timer, and stability would wait for it)
      fixture.detectChanges();
      await new Promise((resolve) => setTimeout(resolve));
      expect(btn('w1').disabled).toBeFalse();
      expect(late.disabled).toBeFalse();
      expect(document.documentElement.classList.contains('nota-readonly')).toBeFalse();
    } finally {
      host.remove();
    }
  });

  it('clock rollback: the banner says the clock is behind', async () => {
    await show(status({ state: 'clock-rollback' }));
    expect(text()).toBe('ساعة الجهاز متأخرة — صلّحها وافتح البرنامج تاني');
    expect(el().querySelector('.trial--red')).not.toBeNull();
  });

  it('the remaining time counts down between polls and flips to expired when the end passes (no restart, no new answer)', async () => {
    signInAs('cashier');
    await show(status({}, 3 * MIN, 2 * DAY));
    expect(text()).toBe('نسخة تجريبية — فاضل 3 دقيقة');
    jasmine.clock().install();
    try {
      jasmine.clock().mockDate(new Date(Date.now() + 4 * MIN));
      (state as unknown as { tick: { set: (v: number) => void } }).tick.set(Date.now());
      await settle();
      expect(text()).toBe('انتهت النسخة التجريبية — البرنامج للعرض بس');
      expect(state.readOnly()).toBeTrue();
    } finally {
      jasmine.clock().uninstall();
    }
  });
});

describe('the interceptor in the read-only state', () => {
  const base = environment.api_base_url;
  let http: HttpTestingController;
  let client: HttpClient;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [TranslateModule.forRoot()],
      providers: [provideRouter([]), provideHttpClient(withInterceptors([authInterceptor])), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    client = TestBed.inject(HttpClient);
    TestBed.inject(AuthService).clear();
    TestBed.inject(TranslateService).setTranslation('en', { trial: { readOnlyAction: 'view only' } });
    TestBed.inject(TranslateService).use('en');
    signInAs('owner');
  });
  afterEach(() => http.verify());

  const expire = () => TestBed.inject(TrialStateService).apply(status({ state: 'expired', remainingMs: 0 }, -HOUR, 31 * DAY));

  it('a write is refused on this PC with 402 LICENSE_EXPIRED and a toast, nothing is sent; reads and the exempt routes go through', () => {
    expire();
    let failure: { status: number; error: { code: string } } | null = null;
    client.post(`${base}sellings`, {}).subscribe({ error: (e) => (failure = e) });
    client.put(`${base}shop-profile`, {}).subscribe({ error: () => undefined });
    client.delete(`${base}products/1`).subscribe({ error: () => undefined });
    http.expectNone(`${base}sellings`);
    http.expectNone(`${base}shop-profile`);
    http.expectNone(`${base}products/1`);
    expect(failure!.status).toBe(402);
    expect(failure!.error.code).toBe('LICENSE_EXPIRED');
    expect(TestBed.inject(ToastService).toasts().some((toast) => toast.text === 'view only')).toBeTrue();

    client.get(`${base}sellings`).subscribe();
    http.expectOne(`${base}sellings`).flush([]);
    client.post(`${base}auth/login`, {}).subscribe();
    http.expectOne(`${base}auth/login`).flush({});
    client.post(`${base}print/reserve`, {}).subscribe();
    http.expectOne(`${base}print/reserve`).flush({});
    client.post(`${base}license/activate`, {}).subscribe();
    http.expectOne(`${base}license/activate`).flush({});
  });

  it('while the trial is active writes are sent as before', () => {
    TestBed.inject(TrialStateService).apply(status());
    client.post(`${base}sellings`, {}).subscribe();
    http.expectOne(`${base}sellings`).flush({});
  });

  it('a 402 LICENSE_EXPIRED from the server (this window did not know yet) shows its message and re-reads the status', () => {
    client.post(`${base}sellings`, {}).subscribe({ error: () => undefined });
    http.expectOne(`${base}sellings`).flush({ code: 'LICENSE_EXPIRED', message: 'انتهت النسخة التجريبية' }, { status: 402, statusText: 'Payment Required' });
    expect(TestBed.inject(ToastService).toasts().some((toast) => toast.text === 'انتهت النسخة التجريبية')).toBeTrue();
    http.expectOne(`${base}license/status`).flush(status({ state: 'expired', remainingMs: 0 }, -HOUR, 31 * DAY));
    expect(TestBed.inject(TrialStateService).readOnly()).toBeTrue();
  });
});

describe('ReadOnlyUi', () => {
  it('names the write controls: save/confirm/new/delete/danger yes; search, print, export, statements no', () => {
    const make = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild as Element; };
    for (const yes of ['<button data-action="save"></button>', '<button data-action="confirm-pay"></button>', '<button data-action="new-supplier"></button>', '<button data-action="delete-product"></button>', '<button notaButton="danger"></button>', '<button data-action="open-shift"></button>']) {
      expect(isWriteControl(make(yes))).withContext(yes).toBeTrue();
    }
    for (const no of ['<button data-action="apply-filters"></button>', '<button data-action="print-invoice"></button>', '<button data-action="export-products"></button>', '<button data-action="pdf-statement"></button>', '<button data-action="cancel"></button>', '<button data-action="login"></button>', '<button data-action="activate-license"></button>', '<button></button>']) {
      expect(isWriteControl(make(no))).withContext(no).toBeFalse();
    }
  });

  it('switching on and off leaves a button that was already disabled alone', () => {
    const host = document.createElement('div');
    host.innerHTML = '<button data-action="save" id="a" disabled>x</button><button data-action="save" id="b">y</button>';
    document.body.appendChild(host);
    const ui = new ReadOnlyUi(document, () => undefined);
    ui.enable();
    ui.disable();
    expect((host.querySelector('#a') as HTMLButtonElement).disabled).toBeTrue();
    expect((host.querySelector('#b') as HTMLButtonElement).disabled).toBeFalse();
    host.remove();
  });
});
