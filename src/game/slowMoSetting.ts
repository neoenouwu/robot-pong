/**
 * Manual slow-mo controls (right mouse button, Shift, the SLOW touch button) are opt-in.
 * The automatic near-miss slow-mo is not affected by this setting.
 */
export const SLOWMO_CONTROLS_STORAGE_KEY = 'robot_pong_slowmo_controls';

/** Reads the stored setting. Only exactly 'on' enables the controls; anything else means off. */
export function parseSlowMoControls(raw: string | null | undefined): boolean {
  return raw === 'on';
}

/** Value to store for the setting. */
export function serializeSlowMoControls(enabled: boolean): 'on' | 'off' {
  return enabled ? 'on' : 'off';
}
