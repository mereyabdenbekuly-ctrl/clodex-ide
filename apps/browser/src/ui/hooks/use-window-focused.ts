import { useCallback, useEffect, useState } from 'react';

function isWindowActive(): boolean {
  return document.hasFocus() || document.visibilityState === 'visible';
}

export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(isWindowActive);

  const update = useCallback(() => {
    setFocused(isWindowActive());
  }, []);

  useEffect(() => {
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    update();
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [update]);

  return focused;
}
