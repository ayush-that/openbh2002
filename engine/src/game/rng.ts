/** MSVC CRT rand(): 15-bit LCG, as used by BH2.exe (FUN_00430230). */
export class Rng {
  private state: number
  constructor(seed = Date.now()) {
    this.state = seed >>> 0
  }
  seed(s: number) {
    this.state = s >>> 0
  }
  /** 0..32767 */
  rand() {
    this.state = (Math.imul(this.state, 214013) + 2531011) >>> 0
    return (this.state >>> 16) & 0x7fff
  }
}
