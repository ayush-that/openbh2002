import type { World } from '../game/world'
import type { Game } from '../game/game'

/** Development overlay: state text (with ?debug) and click-through messages. */
export class DebugHud {
  private el = document.createElement('div')
  private msg = document.createElement('div')
  private world: World
  private game: Game

  constructor(parent: HTMLElement, world: World, game: Game, showText: boolean) {
    this.world = world
    this.game = game
    this.el.hidden = !showText
    this.el.className = 'debug-hud'
    this.msg.className = 'debug-msg'
    this.msg.hidden = true
    parent.append(this.el, this.msg)
  }

  update() {
    if (this.el.hidden) return
    const w = this.world, p = w.player, a = p.ammo
    const weapon = ['GUN', 'CANNON', 'HANDGUN'][p.weapon]
    this.el.textContent =
      `Level ${w.levelNumber}  ${w.daytime ? 'day' : 'night'}  ${w.outcome}${w.paused ? ' (paused)' : ''}\n` +
      `SHIELD ${p.shield}  ENEMY ${w.enemyMeter.toFixed(0)}/${w.enemyMeterInitial}\n` +
      `${weapon}  bullets ${a.bullets}  cannon ${a.cannon}  missiles ${a.missiles} rails ${this.game.player.rails.map(Number).join('')}  flares ${a.flares}  handgun ${a.handgun}\n` +
      `yaw ${p.yaw.toFixed(1)} pitch ${p.pitch.toFixed(1)}  projectiles ${w.projectiles.list.length}  frame ${w.frame}` +
      (this.game.input.locked ? '' : '\nClick to capture the mouse')
  }

  message(text: string, onClick: () => void) {
    this.msg.textContent = text
    this.msg.hidden = false
    document.exitPointerLock()
    this.msg.onclick = () => {
      this.msg.hidden = true
      onClick()
    }
  }
}
