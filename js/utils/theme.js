// Theme helpers — read body class, return theme-conditional values.
// applyTheme() (which has to re-init all chart instances on toggle) lives in
// boot.js for now; it will move out alongside the switcher in a later step.

export function isLight() {
  return document.body.classList.contains("light");
}

export function tc(dark, light) {
  return isLight() ? light : dark;
}

export function mob() {
  return window.innerWidth < 600 || window.innerHeight < 500;
}
