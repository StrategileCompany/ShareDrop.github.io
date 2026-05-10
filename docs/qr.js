export class QRTools extends EventTarget {
  constructor(video) {
    super();
    this.video = video;
    this.stream = null;
    this.detector = "BarcodeDetector" in window
      ? new BarcodeDetector({ formats: ["qr_code"] })
      : null;
    this.scanFrame = 0;
    this.active = false;
  }

  static makeImageUrl(payload, size = 190) {
    const data = encodeURIComponent(payload);
    return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${data}`;
  }

  async start() {
    if (!this.detector) {
      throw new Error("Leitura nativa de QRCode indisponível neste navegador.");
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.active = true;
    this.loop();
  }

  stop() {
    this.active = false;
    cancelAnimationFrame(this.scanFrame);
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
    }
    this.stream = null;
    this.video.srcObject = null;
  }

  async loop() {
    if (!this.active) return;
    try {
      const codes = await this.detector.detect(this.video);
      if (codes.length > 0) {
        this.dispatchEvent(new CustomEvent("scan", { detail: codes[0].rawValue }));
        this.stop();
        return;
      }
    } catch (error) {
      this.dispatchEvent(new CustomEvent("error", { detail: error }));
      this.stop();
      return;
    }
    this.scanFrame = requestAnimationFrame(() => this.loop());
  }
}
