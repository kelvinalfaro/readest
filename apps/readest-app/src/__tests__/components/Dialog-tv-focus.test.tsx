import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appService = { isAndroidApp: true, isTV: true, hasRoundedWindow: false };

vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ appService }) }));
vi.mock('@/store/themeStore', () => ({
  useThemeStore: () => ({ systemUIVisible: false, statusBarHeight: 0, safeAreaInsets: {} }),
}));
vi.mock('@/store/deviceStore', () => ({
  useDeviceControlStore: () => ({
    acquireBackKeyInterception: vi.fn(),
    releaseBackKeyInterception: vi.fn(),
  }),
}));
vi.mock('@/hooks/useResponsiveSize', () => ({ useResponsiveSize: (size: number) => size }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (text: string) => text }));
vi.mock('@/hooks/useDrag', () => ({ useDrag: () => ({ handleDragStart: vi.fn() }) }));
vi.mock('@tauri-apps/plugin-haptics', () => ({ impactFeedback: vi.fn() }));
vi.mock('@/utils/rtl', () => ({ getDirFromUILanguage: () => 'ltr' }));
vi.mock('@/utils/event', () => ({
  eventDispatcher: { onSync: vi.fn(), offSync: vi.fn() },
}));
vi.mock('overlayscrollbars-react', () => ({
  OverlayScrollbarsComponent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock('@/components/Overlay', () => ({ Overlay: () => <div /> }));

import Dialog from '@/components/Dialog';

const setVisibleRect = (element: HTMLElement) => {
  element.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 100,
      bottom: 40,
      width: 100,
      height: 40,
      toJSON: () => ({}),
    }) as DOMRect;
};

describe('Dialog TV focus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('focuses the first actionable control instead of the dialog container', () => {
    const { getByRole } = render(
      <Dialog isOpen title='TV dialog' onClose={vi.fn()}>
        <button>Primary action</button>
      </Dialog>,
    );
    const button = getByRole('button', { name: 'Primary action' });
    setVisibleRect(button);

    act(() => vi.advanceTimersByTime(100));

    expect(document.activeElement).toBe(button);
  });

  it('restores focus when a dialog state replaces the focused control', async () => {
    const { getByRole, rerender } = render(
      <Dialog isOpen title='TV dialog' onClose={vi.fn()}>
        <button>Restore Library</button>
      </Dialog>,
    );
    const restore = getByRole('button', { name: 'Restore Library' });
    setVisibleRect(restore);
    act(() => vi.advanceTimersByTime(100));
    expect(document.activeElement).toBe(restore);

    rerender(
      <Dialog isOpen title='TV dialog' onClose={vi.fn()}>
        <button>Finished</button>
      </Dialog>,
    );
    const finished = getByRole('button', { name: 'Finished' });
    setVisibleRect(finished);
    await act(async () => {
      await Promise.resolve();
      vi.runOnlyPendingTimers();
    });

    expect(document.activeElement).toBe(finished);
  });
});
