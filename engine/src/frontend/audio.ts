// Menu audio: the Fichas/sfx/sonidos.dat click bank and the XM music (preludio.xm, MENU.XM).
// bh2.ews has its own DirectSound mixer and XM player (Exelib). XM playback here uses libopenmpt through the
// chiptune3 AudioWorklet (MIT; libopenmpt is BSD). Volumes follow Exelib's 0..64 scale.
// Browsers only allow audio after a user gesture: call unlock() from a pointer/key handler.
import type { GameFS } from '../vfs'
import workletUrl from 'chiptune3/chiptune3.worklet.js?worker&url'

/** sonidos.dat: u32 offsets[5]; each entry {u32 bytes, 0, 0, u32 rate, u32 bits, u32 ?} then mono PCM. */
function decodeBank(ctx: BaseAudioContext, b: Uint8Array): AudioBuffer[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const first = v.getUint32(0, true)
  const out: AudioBuffer[] = []
  for (let i = 0; i * 4 < first; i++) {
    const o = v.getUint32(i * 4, true)
    if (o + 24 > b.length) break
    const bytes = v.getUint32(o, true), rate = v.getUint32(o + 12, true), bits = v.getUint32(o + 16, true)
    const sixteen = bits === 16
    const n = Math.min(sixteen ? bytes >> 1 : bytes, (b.length - o - 24) >> (sixteen ? 1 : 0))
    const buf = ctx.createBuffer(1, Math.max(1, n), rate || 22050)
    const ch = buf.getChannelData(0)
    for (let k = 0; k < n; k++) ch[k] = sixteen ? v.getInt16(o + 24 + k * 2, true) / 32768 : (b[o + 24 + k] - 128) / 128
    out.push(buf)
  }
  return out
}

export class MenuAudio {
  private ctx: AudioContext | null = null
  private sfxGain: GainNode | null = null
  private musicGain: GainNode | null = null
  private node: AudioWorkletNode | null = null
  private bank: AudioBuffer[] = []
  private files = new Map<string, ArrayBuffer>()
  private fs: GameFS
  private sfxVol = 64
  private musicVol = 64
  /** Module requested before the context existed, played on unlock. */
  private pending: { name: string; order?: number; row?: number } | null = null
  private current = ''
  private retry = 0

  constructor(fs: GameFS) {
    this.fs = fs
  }

  /** Start audio from a user gesture. Safe to call repeatedly. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume()
      return
    }
    const ctx = new AudioContext()
    this.ctx = ctx
    this.sfxGain = ctx.createGain()
    this.musicGain = ctx.createGain()
    this.sfxGain.connect(ctx.destination)
    this.musicGain.connect(ctx.destination)
    this.applyVolumes()
    void this.init(ctx)
  }

  private async init(ctx: AudioContext) {
    try {
      const path = this.fs.list().find((p) => /fichas\/sfx\/sonidos\.dat$/i.test(p))
      if (path) this.bank = decodeBank(ctx, await this.fs.read(path))
    } catch (e) {
      console.warn('menu sfx unavailable', e)
    }
    try {
      await ctx.audioWorklet.addModule(workletUrl)
      const node = new AudioWorkletNode(ctx, 'libopenmpt-processor', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] })
      node.port.postMessage({ cmd: 'config', val: { repeatCount: -1, stereoSeparation: 100, interpolationFilter: 0 } })
      node.port.onmessage = (e: MessageEvent<{ cmd: string }>) => {
        if (e.data.cmd === 'meta') this.retry = -1
      }
      node.connect(this.musicGain!)
      this.node = node
      if (this.pending) {
        const p = this.pending
        this.pending = null
        void this.playModule(p.name, p.order, p.row)
      }
    } catch (e) {
      console.warn('menu music unavailable', e)
    }
  }

  /** FUN_0040ec70: load and start an XM module (path relative to the game root); optional start order/row. */
  async playModule(name: string, order?: number, row?: number) {
    this.current = name
    if (!this.node) {
      this.pending = { name, order, row }
      return
    }
    const path = this.fs.list().find((p) => p.toLowerCase() === name.toLowerCase())
    if (!path) return
    let data = this.files.get(path)
    if (!data) {
      const b = await this.fs.read(path)
      data = b.slice().buffer
      this.files.set(path, data)
    }
    if (this.current !== name) return
    const node = this.node
    // The worklet compiles libopenmpt asynchronously and drops 'play' until it is ready; resend until it reports metadata.
    this.retry = 0
    const send = () => {
      if (this.retry < 0 || this.current !== name) return
      node.port.postMessage({ cmd: 'play', val: data!.slice(0) })
      if (order !== undefined) node.port.postMessage({ cmd: 'setOrderRow', val: { o: order, r: row ?? 0 } })
      if (++this.retry < 20) setTimeout(send, 400)
    }
    send()
  }

  /** FUN_0040ecf0 */
  stopModule() {
    this.current = ''
    this.pending = null
    this.retry = -1
    this.node?.port.postMessage({ cmd: 'stop' })
  }

  /** FUN_0040e590: 0..64 */
  setMusicVolume(v: number) {
    this.musicVol = Math.max(0, Math.min(64, v))
    this.applyVolumes()
  }

  /** FUN_0040e540: 0..64 */
  setSfxVolume(v: number) {
    this.sfxVol = Math.max(0, Math.min(64, v))
    this.applyVolumes()
  }

  private applyVolumes() {
    if (this.musicGain) this.musicGain.gain.value = (this.musicVol / 64) * 0.7
    if (this.sfxGain) this.sfxGain.gain.value = this.sfxVol / 64
  }

  /** FUN_0040e5d0(bank, index, 0x80, 0x40): 0 = nav button, 2 = menu bar, 3 = weapons chart hover. */
  sfx(index: number) {
    const ctx = this.ctx, buf = this.bank[index]
    if (!ctx || !buf || !this.sfxGain || this.sfxVol === 0) return
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(this.sfxGain)
    src.start()
  }
}
