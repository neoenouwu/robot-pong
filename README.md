# Robot Pong

3D table tennis against a robot, playable in the browser.

**Play it here: https://neoenouwu.github.io/robot-pong/**

## Controls

### Mouse and keyboard

| Input | Action |
| --- | --- |
| Mouse | Move the paddle |
| Left click / Space | Serve; hold to charge a smash |
| C | Toggle 1:1 paddle tracking |
| M | Mute / unmute |
| Esc / P | Pause |

### Touch screens

| Input | Action |
| --- | --- |
| Drag | Move the paddle |
| Tap | Serve |
| Hold SMASH, or a second finger | Charge a smash; release to swing |
| PAUSE | Pause |

Manual slow-mo is off by default. Turn on **Slow-Mo** in Settings to use it: hold right click or Shift, or the SLOW button on a touch screen.

## Settings

Open **Settings** from the main menu.

- **Health Bars** — in Story, show two health bars instead of the score readout.
- **Slow-Mo** — enable the manual slow-mo controls.
- **SFX** and **Bloom** — sound effects and the glow effect.

## Modes

- **Story** — first to 5 points, on Easy, Medium or Hard.
- **Arcade** — 3 shields, endless.

Scores are saved in your own browser.

## Run it locally

```bash
pnpm install
pnpm dev
```

`pnpm test` runs the tests and `pnpm build` produces the static site in `dist/`.
