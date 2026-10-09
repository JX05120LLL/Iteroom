/** A failed open can still own a browser. Only a confirmed close settles its resource. */
export class ProbeBrowserSession {
  constructor(call) { this.call = call; this.attempted = false }
  async open(url) {
    this.attempted = true
    return this.call(['open', url])
  }
  async close() {
    if (!this.attempted) return null
    await this.call(['close'])
    this.attempted = false
    return true
  }
}
