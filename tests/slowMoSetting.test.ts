import { describe, expect, it } from 'vitest';
import {
  parseSlowMoControls,
  serializeSlowMoControls,
  SLOWMO_CONTROLS_STORAGE_KEY,
} from '../src/game/slowMoSetting';

describe('parseSlowMoControls', () => {
  it('is on only for the stored value on', () => {
    expect(parseSlowMoControls('on')).toBe(true);
    expect(parseSlowMoControls('off')).toBe(false);
  });

  it('is off for missing or empty values', () => {
    expect(parseSlowMoControls(null)).toBe(false);
    expect(parseSlowMoControls(undefined)).toBe(false);
    expect(parseSlowMoControls('')).toBe(false);
  });

  it('is off for unknown or wrongly cased values', () => {
    expect(parseSlowMoControls('ON')).toBe(false);
    expect(parseSlowMoControls(' on')).toBe(false);
    expect(parseSlowMoControls('true')).toBe(false);
    expect(parseSlowMoControls('1')).toBe(false);
  });

  it('round-trips through the stored form', () => {
    expect(parseSlowMoControls(serializeSlowMoControls(true))).toBe(true);
    expect(parseSlowMoControls(serializeSlowMoControls(false))).toBe(false);
    expect(serializeSlowMoControls(true)).toBe('on');
    expect(serializeSlowMoControls(false)).toBe('off');
  });

  it('uses the agreed storage key', () => {
    expect(SLOWMO_CONTROLS_STORAGE_KEY).toBe('robot_pong_slowmo_controls');
  });
});
