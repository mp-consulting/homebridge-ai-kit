/**
 * Loaded first, before the stylesheets, so the page never flashes the wrong
 * theme. Starts from the system preference; app.js then applies the
 * Homebridge user's own setting (light, dark or auto) through AiKitTheme.set().
 * A file rather than an inline script: the Homebridge UI's content-security
 * policy only allows same-origin scripts.
 */
(() => {
  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const listeners = [];
  let mode = 'auto';

  function apply() {
    const dark = mode === 'dark' || (mode !== 'light' && !!media && media.matches);
    document.documentElement.dataset.bsTheme = dark ? 'dark' : 'light';
  }

  apply();
  if (media && media.addEventListener) {
    media.addEventListener('change', () => {
      apply();
      listeners.forEach((listener) => {
        listener();
      });
    });
  }

  window.AiKitTheme = {
    /** 'light', 'dark', or anything else to follow the system. */
    set(value) {
      mode = value === 'light' || value === 'dark' ? value : 'auto';
      apply();
    },
    /** Called when the system preference changes. */
    onSystemChange(listener) {
      listeners.push(listener);
    },
  };
})();
