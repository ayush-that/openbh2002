// Loads every image bh2.ews loads (FUN_00403ed0, FUN_00403b60, FUN_00404b70), keyed by short names.
import type { GameFS } from '../vfs'
import { applyAlphaMask, decodeImage, picCanvas } from './image'

export type Tex = OffscreenCanvas
/** A full-screen "ficha": four tiles <base>01..04 drawn as a 2x2 card. */
export type Card = [Tex, Tex, Tex, Tex]

const TEX = 'Fichas/TEXMENU/'

export const VEHICLE_CARDS = ['APC1', 'APC2', 'APC3', 'MBT70', 'B58', 'F104', 'CH53', 'C130', 'Cobra'] as const

export interface MenuAssets {
  ini: Card
  infogrames: Tex
  digital: Tex
  titulo: Tex
  disclaimer: Tex
  /** bordeizq, bordesup1, bordesup2, bordeder, bordeinf1, bordeinf2, puertaizq, puertader */
  frame: Tex[]
  botones: Tex
  dropdowns: { file: Tex; options: Tex; help: Tex }
  fondo: Card
  score: Card
  options: { video: Card; audio: Card; controls: Card }
  navButtons: Tex
  highlight: Tex
  flecha: Tex
  flechita: Tex
  cuadrados: Tex
  vehicleList: Tex
  controls: { rat: Card; key: Card; joy: Card; interface: Card; gamescreen: Card }
  overview: Card[]
  saveload: { load: Card; save: Card }
  credits: Card[]
  /** Title-screen buttons. "load game.tga" is the bottom-right button; its art reads OPTIONS and it opens the FILE menu. */
  title: { credits: Tex; exit: Tex; help: Tex; play: Tex; final: Tex; loadGame: Tex }
  metralletita: Tex
  radio: Tex
  espejito: Tex
  gunOff: Tex
  gunOn: Tex
  menuVideo: Tex
  menuAudio: Tex
  menuControls: Tex
  vehicleCards: Card[]
}

export async function loadMenuAssets(fs: GameFS): Promise<MenuAssets> {
  const pic = async (path: string) => decodeImage(path, await fs.read(path))
  const tex = async (path: string) => picCanvas(await pic(path))
  const t = (name: string) => tex(TEX + name)
  const card = async (dir: string, base: string): Promise<Card> => {
    const [a, b, c, d] = await Promise.all([1, 2, 3, 4].map((i) => tex(`${dir}${base}0${i}.tga`)))
    return [a, b, c, d]
  }
  const gun = async (name: string) => picCanvas(applyAlphaMask(await pic(TEX + name), await pic(TEX + 'metralletaa.gif')))
  const all = <T extends Record<string, Promise<unknown>>>(o: T) =>
    Promise.all(Object.values(o)).then((v) => Object.fromEntries(Object.keys(o).map((k, i) => [k, v[i]])) as { [K in keyof T]: Awaited<T[K]> })

  return all({
    ini: card(TEX, 'ini'),
    infogrames: t('infogrames.tga'),
    digital: t('digital.tga'),
    titulo: t('beachhead titulo.tga'),
    disclaimer: t('Disclaimer.tga'),
    frame: Promise.all(['bordeizq', 'bordesup1', 'bordesup2', 'bordeder', 'bordeinf1', 'bordeinf2', 'puertaizq', 'puertader'].map((n) => t(n + '.tga'))),
    botones: t('botones.tga'),
    dropdowns: all({ file: t('menu1 file.tga'), options: t('menu2 opciones.tga'), help: t('menu3 help.tga') }),
    fondo: card(TEX, 'fondo'),
    score: card('Fichas/scores/', 'score'),
    options: all({ video: card('Fichas/Options/', 'Video'), audio: card('Fichas/Options/', 'Audio'), controls: card('Fichas/Options/', 'Controls') }),
    navButtons: t('botones interior alpha.tga'),
    highlight: t('highlight azul.tga'),
    flecha: t('flecha.tga'),
    flechita: t('flechita.tga'),
    cuadrados: t('cuadrados.tga'),
    vehicleList: t('listavehiculos01.tga'),
    controls: all({
      rat: card('Fichas/controls/', 'rat'),
      key: card('Fichas/controls/', 'key'),
      joy: card('Fichas/controls/', 'joy'),
      interface: card('Fichas/controls/', 'interface'),
      gamescreen: card('Fichas/controls/', 'gamescreen'),
    }),
    overview: Promise.all(['overview', 'tips', 'weapons1', 'weapons2', 'weapons3'].map((n) => card('Fichas/overview/', n))),
    saveload: all({ load: card('Fichas/saveload/', 'load'), save: card('Fichas/saveload/', 'save') }),
    credits: Promise.all(['credA', 'credB', 'credC', 'credD', 'credE'].map((n) => card('Fichas/creditos/', n))),
    title: all({
      credits: t('credits.tga'),
      exit: t('exit.tga'),
      help: t('help.tga'),
      play: t('play.tga'),
      final: t('final.tga'),
      loadGame: t('load game.tga'),
    }),
    metralletita: t('metralletita.tga'),
    radio: t('radio.tga'),
    espejito: t('espejito.tga'),
    gunOff: gun('metralletaoff.pcx'),
    gunOn: gun('metralletaon.pcx'),
    menuVideo: t('menu2video.tga'),
    menuAudio: t('menuaudio.tga'),
    menuControls: t('menucontrols.tga'),
    vehicleCards: Promise.all(VEHICLE_CARDS.map((n) => card('Fichas/data/', n))),
  })
}
