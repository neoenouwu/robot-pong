/**
 * Development Robot Skin Registry (purely aesthetic — identical AI, hitboxes, and physics).
 * Add new experimental robot .glb models here to preview and compare them live in-game.
 */
export interface RobotSkinDefinition {
  id: string;
  name: string;
  badge: string;
  modelUrl: string;
  armArcStyle: 'classic' | 'high_coil';
}

export const DEFAULT_ROBOT_SKIN_ID = 'classic';

export const ROBOT_SKINS: readonly RobotSkinDefinition[] = [
  {
    id: 'classic',
    name: 'MK-I CLASSIC',
    badge: 'DEFAULT',
    modelUrl: '/models/robot.glb',
    armArcStyle: 'classic',
  },
  {
    id: 'reference',
    name: 'CONCEPT 1:1',
    badge: 'ARTWORK',
    modelUrl: '/models/robot_reference.glb',
    armArcStyle: 'high_coil',
  },
] as const;

export function getRobotSkin(id: string | null | undefined): RobotSkinDefinition {
  if (id) {
    const found = ROBOT_SKINS.find((skin) => skin.id === id);
    if (found) return found;
  }
  return ROBOT_SKINS[0];
}
