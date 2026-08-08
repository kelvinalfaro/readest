'use client';

import { useEffect } from 'react';
import { useEnv } from '@/context/EnvContext';
import {
  findNextTVFocusTarget,
  getTVFocusables,
  isTVEditableControl,
  type TVNavigationDirection,
} from '@/utils/tvNavigation';

const KEY_DIRECTIONS: Partial<Record<string, TVNavigationDirection>> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

const TVModeController = () => {
  const { appService } = useEnv();

  useEffect(() => {
    if (!appService?.isTV) return;
    document.documentElement.dataset['tv'] = 'true';

    const focusInitialControl = () => {
      if (document.activeElement && document.activeElement !== document.body) return;
      getTVFocusables()[0]?.focus();
    };
    const initialFocusTimer = window.setTimeout(focusInitialControl, 100);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const direction = KEY_DIRECTIONS[event.key];
      if (!direction) return;

      const current = document.activeElement as HTMLElement | null;
      if (isTVEditableControl(current)) return;

      const focusables = getTVFocusables();
      if (focusables.length === 0) return;
      const next =
        current && focusables.includes(current)
          ? findNextTVFocusTarget(current, focusables, direction)
          : focusables[0];
      if (!next) return;

      next.focus();
      next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('focus', focusInitialControl);
    return () => {
      window.clearTimeout(initialFocusTimer);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('focus', focusInitialControl);
      delete document.documentElement.dataset['tv'];
    };
  }, [appService?.isTV]);

  return null;
};

export default TVModeController;
