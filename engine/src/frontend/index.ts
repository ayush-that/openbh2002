// Public entry point of the front end (menus). See docs/dev/frontend.md for how main.ts wires it.
import type { GameFS } from '../vfs'
import { loadMenuAssets } from './assets'
import { MenuAudio } from './audio'
import { Frontend } from './frontend'
import { Store } from './store'

export type { PlayOptions, GameResult } from './frontend'
export type { Frontend }

/** Load the menu art and saved state, and mount a hidden full-size menu layer into `container`. `mute` silences music and clicks. */
export async function createFrontend(container: HTMLElement, fs: GameFS, mute = false): Promise<Frontend> {
  const [assets, store] = await Promise.all([loadMenuAssets(fs), Store.open(fs)])
  return new Frontend(container, fs, assets, store, new MenuAudio(fs, mute))
}
