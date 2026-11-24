import { describe, expect, it } from 'vitest';
import { HUD_STYLE_STORAGE_KEY, parseHudStyle } from '../src/game/hudStyle';

describe('parseHudStyle', () => {
  it('accepts the two valid values', () => {
    expect(parseHudStyle('classic')).toBe('classic');
    expect(parseHudStyle('bars')).toBe('bars');
  });

  it('falls back to classic for missing or empty values', () => {
    expect(parseHudStyle(null)).toBe('classic');
    expect(parseHudStyle(undefined)).toBe('classic');
    expect(parseHudStyle('')).toBe('classic');
  });

  it('falls back to classic for unknown or wrongly cased values', () => {
    expect(parseHudStyle('BARS')).toBe('classic');
    expect(parseHudStyle('Bars')).toBe('classic');
    expect(parseHudStyle(' bars')).toBe('classic');
    expect(parseHudStyle('health')).toBe('classic');
    expect(parseHudStyle('true')).toBe('classic');
  });

  it('uses the agreed storage key', () => {
    expect(HUD_STYLE_STORAGE_KEY).toBe('robot_pong_hud_style');
  });
});
