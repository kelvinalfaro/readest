import { afterEach, describe, expect, it } from 'vitest';
import { findNextTVFocusTarget, getTVFocusables } from '@/utils/tvNavigation';

const setRect = (element: HTMLElement, x: number, y: number) => {
  element.getBoundingClientRect = () =>
    ({
      x,
      y,
      left: x,
      top: y,
      right: x + 80,
      bottom: y + 40,
      width: 80,
      height: 40,
      toJSON: () => ({}),
    }) as DOMRect;
};

afterEach(() => {
  document.body.replaceChildren();
});

describe('TV spatial navigation', () => {
  it('filters hidden and disabled controls from the focus set', () => {
    document.body.innerHTML = `
      <button id="first">First</button>
      <button id="disabled" disabled>Disabled</button>
      <button id="hidden" style="display:none">Hidden</button>
      <a id="link" href="/library">Library</a>
    `;
    const first = document.querySelector<HTMLElement>('#first')!;
    const link = document.querySelector<HTMLElement>('#link')!;
    setRect(first, 0, 0);
    setRect(link, 100, 0);

    expect(getTVFocusables(document)).toEqual([first, link]);
  });

  it('chooses the nearest control in the requested direction', () => {
    document.body.innerHTML = `
      <button id="current">Current</button>
      <button id="right">Right</button>
      <button id="down">Down</button>
      <button id="diagonal">Diagonal</button>
    `;
    const current = document.querySelector<HTMLElement>('#current')!;
    const right = document.querySelector<HTMLElement>('#right')!;
    const down = document.querySelector<HTMLElement>('#down')!;
    const diagonal = document.querySelector<HTMLElement>('#diagonal')!;
    setRect(current, 0, 0);
    setRect(right, 120, 0);
    setRect(down, 0, 100);
    setRect(diagonal, 150, 90);
    const controls = [current, right, down, diagonal];

    expect(findNextTVFocusTarget(current, controls, 'right')).toBe(right);
    expect(findNextTVFocusTarget(current, controls, 'down')).toBe(down);
  });

  it('keeps navigation inside the active dialog', () => {
    document.body.innerHTML = `
      <button id="outside">Outside</button>
      <dialog open><button id="inside">Inside</button></dialog>
    `;
    const outside = document.querySelector<HTMLElement>('#outside')!;
    const inside = document.querySelector<HTMLElement>('#inside')!;
    setRect(outside, 0, 0);
    setRect(inside, 100, 0);

    expect(getTVFocusables(document)).toEqual([inside]);
  });
});
