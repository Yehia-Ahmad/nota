import { isWriteControl } from './trial-banner';

const WRITE_CONTROLS = '[data-action], button[notaButton="danger"]';

/**
 * While the trial is over: every control that writes data (see isWriteControl) is disabled and marked, including the ones that appear later
 * (dialogs, pages that load after this was switched on). A link that writes (e.g. "+ new purchase") cannot be disabled, so a capture-phase
 * click guard stops it and says why. Switching off puts everything back exactly as it was.
 */
export class ReadOnlyUi {
  private observer: MutationObserver | null = null;
  private active = false;

  constructor(
    private readonly doc: Document,
    /** Called with a click the guard stopped (shows the "view-only" message). */
    private readonly onBlocked: () => void
  ) {}

  private readonly guard = (event: Event): void => {
    const target = event.target instanceof Element ? event.target.closest('[data-readonly]') : null;
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.onBlocked();
  };

  enable(): void {
    if (this.active) return;
    this.active = true;
    this.doc.documentElement.classList.add('nota-readonly');
    this.mark(this.doc.body);
    this.observer = new MutationObserver((records) => {
      for (const record of records) record.addedNodes.forEach((node) => node instanceof Element && this.mark(node));
    });
    this.observer.observe(this.doc.body, { childList: true, subtree: true });
    this.doc.addEventListener('click', this.guard, true);
  }

  disable(): void {
    if (!this.active) return;
    this.active = false;
    this.observer?.disconnect();
    this.observer = null;
    this.doc.removeEventListener('click', this.guard, true);
    this.doc.documentElement.classList.remove('nota-readonly');
    this.doc.querySelectorAll('[data-readonly]').forEach((element) => {
      element.removeAttribute('data-readonly');
      element.removeAttribute('aria-disabled');
      if (element.hasAttribute('data-ro-disabled')) {
        element.removeAttribute('data-ro-disabled');
        (element as HTMLButtonElement).disabled = false;
      }
    });
  }

  private mark(root: Element): void {
    const candidates = [...(root.matches(WRITE_CONTROLS) ? [root] : []), ...Array.from(root.querySelectorAll(WRITE_CONTROLS))];
    for (const element of candidates) {
      if (element.hasAttribute('data-readonly') || !isWriteControl(element)) continue;
      element.setAttribute('data-readonly', 'true');
      element.setAttribute('aria-disabled', 'true');
      if (element instanceof HTMLButtonElement && !element.disabled) {
        element.disabled = true;
        element.setAttribute('data-ro-disabled', 'true');
      }
    }
  }
}
