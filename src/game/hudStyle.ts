/** 'classic' is the original HUD; 'bars' is the opt-in health bar HUD. */
export type HudStyle = 'classic' | 'bars';

export const HUD_STYLE_STORAGE_KEY = 'robot_pong_hud_style';

/** Reads a stored HUD style. Anything other than exactly 'bars' means classic. */
export function parseHudStyle(raw: string | null | undefined): HudStyle {
  return raw === 'bars' ? 'bars' : 'classic';
}
