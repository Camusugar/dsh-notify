// @camusugar/dsh-notify — host-side entry (dual-face package).
// No host-side behavior: all observable work happens in the browser through
// exports["./client"], discovered from the package.json dsh.client
// declaration. This empty apply gives the Cordis Loader a host row to
// activate (same pattern as the official browser-only surface plugins).
export function apply() {}
