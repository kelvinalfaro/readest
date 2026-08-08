export type TVNavigationDirection = 'left' | 'right' | 'up' | 'down';

const TV_FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[role="button"][tabindex]:not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const isVisible = (element: HTMLElement) => {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    element.getAttribute('aria-hidden') !== 'true'
  );
};

export function getTVFocusables(root: ParentNode = document): HTMLElement[] {
  const dialogs = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]'));
  const scope: ParentNode = dialogs.at(-1) ?? root;
  return Array.from(scope.querySelectorAll<HTMLElement>(TV_FOCUSABLE_SELECTOR)).filter(isVisible);
}

export function findNextTVFocusTarget(
  current: HTMLElement,
  candidates: HTMLElement[],
  direction: TVNavigationDirection,
): HTMLElement | null {
  const currentRect = current.getBoundingClientRect();
  const currentX = currentRect.left + currentRect.width / 2;
  const currentY = currentRect.top + currentRect.height / 2;

  let best: { element: HTMLElement; score: number } | null = null;
  for (const element of candidates) {
    if (element === current) continue;
    const rect = element.getBoundingClientRect();
    const dx = rect.left + rect.width / 2 - currentX;
    const dy = rect.top + rect.height / 2 - currentY;
    const isInDirection =
      (direction === 'left' && dx < 0) ||
      (direction === 'right' && dx > 0) ||
      (direction === 'up' && dy < 0) ||
      (direction === 'down' && dy > 0);
    if (!isInDirection) continue;

    const primaryDistance =
      direction === 'left' || direction === 'right' ? Math.abs(dx) : Math.abs(dy);
    const crossDistance =
      direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
    const score = primaryDistance + crossDistance * 0.35;
    if (!best || score < best.score) best = { element, score };
  }
  return best?.element ?? null;
}

export const isTVEditableControl = (element: HTMLElement | null) =>
  element instanceof HTMLInputElement ||
  element instanceof HTMLTextAreaElement ||
  element instanceof HTMLSelectElement;
