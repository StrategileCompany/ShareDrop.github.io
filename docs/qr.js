const BYTE_CAPACITY_L = [0, 17, 32, 53, 78, 106, 134, 154, 192, 230, 271];
const QR_BLOCKS_L = {
  1: { ec: 7, groups: [{ count: 1, data: 19 }] },
  2: { ec: 10, groups: [{ count: 1, data: 34 }] },
  3: { ec: 15, groups: [{ count: 1, data: 55 }] },
  4: { ec: 20, groups: [{ count: 1, data: 80 }] },
  5: { ec: 26, groups: [{ count: 1, data: 108 }] },
  6: { ec: 18, groups: [{ count: 2, data: 68 }] },
  7: { ec: 20, groups: [{ count: 2, data: 78 }] },
  8: { ec: 24, groups: [{ count: 2, data: 97 }] },
  9: { ec: 30, groups: [{ count: 2, data: 116 }] },
  10: { ec: 18, groups: [{ count: 2, data: 68 }, { count: 2, data: 69 }] }
};
const ALIGNMENT_POSITIONS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50]
};

class BitBuffer {
  constructor() {
    this.bits = [];
  }

  append(value, length) {
    for (let i = length - 1; i >= 0; i -= 1) {
      this.bits.push((value >>> i) & 1);
    }
  }

  appendBytes(bytes) {
    for (const byte of bytes) {
      this.append(byte, 8);
    }
  }

  toBytes() {
    const out = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let value = 0;
      for (let j = 0; j < 8; j += 1) {
        value = (value << 1) | (this.bits[i + j] ?? 0);
      }
      out.push(value);
    }
    return out;
  }
}

class ReedSolomon {
  constructor() {
    this.exp = new Array(512);
    this.log = new Array(256);
    let x = 1;
    for (let i = 0; i < 255; i += 1) {
      this.exp[i] = x;
      this.log[x] = i;
      x <<= 1;
      if (x & 0x100) {
        x ^= 0x11d;
      }
    }
    for (let i = 255; i < 512; i += 1) {
      this.exp[i] = this.exp[i - 255];
    }
  }

  multiply(a, b) {
    if (a === 0 || b === 0) {
      return 0;
    }
    return this.exp[this.log[a] + this.log[b]];
  }

  generator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i += 1) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j += 1) {
        next[j] ^= this.multiply(poly[j], this.exp[i]);
        next[j + 1] ^= poly[j];
      }
      poly = next;
    }
    return poly;
  }

  remainder(data, degree) {
    const gen = this.generator(degree);
    const result = new Array(degree).fill(0);
    for (const byte of data) {
      const factor = byte ^ result.shift();
      result.push(0);
      for (let i = 0; i < degree; i += 1) {
        result[i] ^= this.multiply(gen[i], factor);
      }
    }
    return result;
  }
}

const RS = new ReedSolomon();

export class QRCodeCanvas {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
  }

  draw(text) {
    const qr = createQrMatrix(text);
    const size = qr.length;
    const scale = Math.floor(Math.min(this.canvas.width, this.canvas.height) / (size + 8));
    const offset = Math.floor((this.canvas.width - size * scale) / 2);

    this.ctx.fillStyle = "#ffffff";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.fillStyle = "#111827";
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (qr[y][x]) {
          this.ctx.fillRect(offset + x * scale, offset + y * scale, scale, scale);
        }
      }
    }
  }
}

export class QRRotator {
  constructor(canvas, chunks, { interval = 850, onFrame, preferRemote = true } = {}) {
    this.canvas = canvas;
    this.chunks = chunks;
    this.interval = interval;
    this.onFrame = onFrame;
    this.preferRemote = preferRemote;
    this.index = 0;
    this.timer = null;
    this.renderer = new QRCodeCanvas(canvas);
  }

  start() {
    this.stop();
    this.paint();
    this.timer = window.setInterval(() => this.paint(), this.interval);
  }

  paint() {
    const chunk = this.chunks[this.index];
    this.drawChunk(chunk);
    this.onFrame?.(this.index + 1, this.chunks.length);
    this.index = (this.index + 1) % this.chunks.length;
  }

  drawChunk(chunk) {
    if (!this.preferRemote || !navigator.onLine) {
      this.renderer.draw(chunk);
      return;
    }
    const image = new Image();
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.onload = () => {
      const ctx = this.canvas.getContext("2d", { alpha: false });
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(image, 0, 0, this.canvas.width, this.canvas.height);
    };
    image.onerror = () => this.renderer.draw(chunk);
    image.src = `https://api.qrserver.com/v1/create-qr-code/?size=${this.canvas.width}x${this.canvas.height}&margin=12&data=${encodeURIComponent(chunk)}`;
  }

  stop() {
    if (this.timer) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export class PairingPayloadCodec {
  static async encode(payload) {
    const json = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(json);
    if ("CompressionStream" in window) {
      const compressed = await streamBytes(bytes, new CompressionStream("gzip"));
      return `MDP1.gzip.${base64UrlEncode(compressed)}`;
    }
    return `MDP1.json.${base64UrlEncode(bytes)}`;
  }

  static async decode(text) {
    const payload = text.trim();
    if (!payload.startsWith("MDP1.")) {
      throw new Error("Payload de pareamento inválido.");
    }
    const [, encoding, encoded] = payload.split(".");
    let bytes = base64UrlDecode(encoded);
    if (encoding === "gzip") {
      if (!("DecompressionStream" in window)) {
        throw new Error("Este navegador não consegue descomprimir o payload. Use copiar/colar em texto JSON.");
      }
      bytes = await streamBytes(bytes, new DecompressionStream("gzip"));
    }
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json);
  }

  static chunk(encoded, chunkSize = 180) {
    const id = crypto.randomUUID().slice(0, 8);
    const total = Math.ceil(encoded.length / chunkSize);
    if (total <= 1) {
      return [encoded];
    }
    return Array.from({ length: total }, (_, index) => {
      const data = encoded.slice(index * chunkSize, (index + 1) * chunkSize);
      return `MD1|${id}|${index}|${total}|${data}`;
    });
  }
}

export class PairingAssembler {
  constructor() {
    this.groups = new Map();
  }

  add(rawText) {
    const text = rawText.trim();
    if (text.startsWith("MDP1.")) {
      return { complete: true, encoded: text, progress: { done: 1, total: 1 } };
    }
    if (!text.startsWith("MD1|")) {
      return { complete: false, ignored: true };
    }
    const [, id, indexRaw, totalRaw, data] = text.split("|");
    const index = Number(indexRaw);
    const total = Number(totalRaw);
    if (!id || !Number.isInteger(index) || !Number.isInteger(total) || index < 0 || index >= total) {
      return { complete: false, ignored: true };
    }
    if (!this.groups.has(id)) {
      this.groups.set(id, { total, parts: new Array(total) });
    }
    const group = this.groups.get(id);
    group.parts[index] = data;
    const done = group.parts.filter(Boolean).length;
    if (done === total) {
      this.groups.delete(id);
      return { complete: true, encoded: group.parts.join(""), progress: { done, total } };
    }
    return { complete: false, progress: { done, total } };
  }
}

export class QRScanner extends EventTarget {
  constructor(video) {
    super();
    this.video = video;
    this.detector = null;
    this.stream = null;
    this.running = false;
    this.assembler = new PairingAssembler();
    this.seen = new Set();
  }

  async start() {
    if (!("BarcodeDetector" in window)) {
      throw new Error("Leitura de QR por câmera não está disponível neste navegador. Use copiar/colar.");
    }
    this.detector = new BarcodeDetector({ formats: ["qr_code"] });
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.running = true;
    this.loop();
  }

  stop() {
    this.running = false;
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  async loop() {
    while (this.running) {
      try {
        const codes = await this.detector.detect(this.video);
        for (const code of codes) {
          const value = code.rawValue;
          if (!value || this.seen.has(value)) {
            continue;
          }
          this.seen.add(value);
          const result = this.assembler.add(value);
          if (result.progress) {
            this.dispatchEvent(new CustomEvent("progress", { detail: result.progress }));
          }
          if (result.complete) {
            this.dispatchEvent(new CustomEvent("payload", { detail: result.encoded }));
            return;
          }
        }
      } catch (error) {
        this.dispatchEvent(new CustomEvent("error", { detail: error }));
        return;
      }
      await new Promise(resolve => window.setTimeout(resolve, 180));
    }
  }
}

function createQrMatrix(text) {
  const bytes = new TextEncoder().encode(text);
  const version = BYTE_CAPACITY_L.findIndex((capacity, index) => index > 0 && bytes.length <= capacity);
  if (version < 1) {
    throw new Error("Trecho muito grande para QR local. Reduza o tamanho do chunk.");
  }
  const dataCodewords = encodeData(bytes, version);
  const allCodewords = addErrorCorrection(dataCodewords, version);
  const base = createBaseMatrix(version);
  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const matrix = cloneMatrix(base.matrix);
    placeCodewords(matrix, base.functionModules, allCodewords);
    applyMask(matrix, base.functionModules, mask);
    drawFormatBits(matrix, mask);
    const penalty = getPenalty(matrix);
    if (!best || penalty < best.penalty) {
      best = { matrix, penalty };
    }
  }
  return best.matrix;
}

function encodeData(bytes, version) {
  const blocks = QR_BLOCKS_L[version];
  const totalData = blocks.groups.reduce((sum, group) => sum + group.count * group.data, 0);
  const bits = new BitBuffer();
  bits.append(0b0100, 4);
  bits.append(bytes.length, version < 10 ? 8 : 16);
  bits.appendBytes(bytes);
  const capacityBits = totalData * 8;
  bits.append(0, Math.min(4, capacityBits - bits.bits.length));
  while (bits.bits.length % 8 !== 0) {
    bits.append(0, 1);
  }
  const data = bits.toBytes();
  for (let pad = 0; data.length < totalData; pad += 1) {
    data.push(pad % 2 === 0 ? 0xec : 0x11);
  }
  return data;
}

function addErrorCorrection(data, version) {
  const spec = QR_BLOCKS_L[version];
  const blocks = [];
  let offset = 0;
  for (const group of spec.groups) {
    for (let i = 0; i < group.count; i += 1) {
      const slice = data.slice(offset, offset + group.data);
      offset += group.data;
      blocks.push({ data: slice, ec: RS.remainder(slice, spec.ec) });
    }
  }
  const result = [];
  const maxData = Math.max(...blocks.map(block => block.data.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) {
      if (i < block.data.length) {
        result.push(block.data[i]);
      }
    }
  }
  for (let i = 0; i < spec.ec; i += 1) {
    for (const block of blocks) {
      result.push(block.ec[i]);
    }
  }
  return result;
}

function createBaseMatrix(version) {
  const size = version * 4 + 17;
  const matrix = Array.from({ length: size }, () => Array(size).fill(false));
  const functionModules = Array.from({ length: size }, () => Array(size).fill(false));
  const set = (x, y, value, isFunction = true) => {
    if (x < 0 || y < 0 || x >= size || y >= size) {
      return;
    }
    matrix[y][x] = value;
    functionModules[y][x] = isFunction;
  };

  drawFinder(set, 3, 3);
  drawFinder(set, size - 4, 3);
  drawFinder(set, 3, size - 4);

  for (let i = 8; i < size - 8; i += 1) {
    set(i, 6, i % 2 === 0);
    set(6, i, i % 2 === 0);
  }

  for (const y of ALIGNMENT_POSITIONS[version]) {
    for (const x of ALIGNMENT_POSITIONS[version]) {
      if ((x === 6 && y === 6) || (x === 6 && y === size - 7) || (x === size - 7 && y === 6)) {
        continue;
      }
      drawAlignment(set, x, y);
    }
  }

  set(8, size - 8, true);
  for (let i = 0; i < 9; i += 1) {
    if (i !== 6) {
      set(8, i, false);
      set(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i += 1) {
    set(size - 1 - i, 8, false);
    set(8, size - 1 - i, false);
  }

  return { matrix, functionModules };
}

function drawFinder(set, cx, cy) {
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      set(cx + dx, cy + dy, dist !== 2 && dist !== 4);
    }
  }
}

function drawAlignment(set, cx, cy) {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      set(cx + dx, cy + dy, dist !== 1);
    }
  }
}

function placeCodewords(matrix, functionModules, codewords) {
  const size = matrix.length;
  const bits = codewords.flatMap(byte => Array.from({ length: 8 }, (_, i) => (byte >>> (7 - i)) & 1));
  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right -= 1;
    }
    for (let vert = 0; vert < size; vert += 1) {
      const y = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        if (!functionModules[y][x]) {
          matrix[y][x] = Boolean(bits[bitIndex] ?? 0);
          bitIndex += 1;
        }
      }
    }
    upward = !upward;
  }
}

function applyMask(matrix, functionModules, mask) {
  const size = matrix.length;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!functionModules[y][x] && maskBit(mask, x, y)) {
        matrix[y][x] = !matrix[y][x];
      }
    }
  }
}

function maskBit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return false;
  }
}

function drawFormatBits(matrix, mask) {
  const size = matrix.length;
  const data = (0b01 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) {
    rem <<= 1;
    if ((rem >>> 10) & 1) {
      rem ^= 0x537;
    }
  }
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = i => Boolean((bits >>> i) & 1);

  for (let i = 0; i <= 5; i += 1) matrix[8][i] = bit(i);
  matrix[8][7] = bit(6);
  matrix[8][8] = bit(7);
  matrix[7][8] = bit(8);
  for (let i = 9; i < 15; i += 1) matrix[14 - i][8] = bit(i);

  for (let i = 0; i < 8; i += 1) matrix[size - 1 - i][8] = bit(i);
  for (let i = 8; i < 15; i += 1) matrix[8][size - 15 + i] = bit(i);
}

function getPenalty(matrix) {
  const size = matrix.length;
  let penalty = 0;
  const scoreLine = line => {
    let score = 0;
    let runColor = line[0];
    let runLength = 1;
    for (let i = 1; i < line.length; i += 1) {
      if (line[i] === runColor) {
        runLength += 1;
      } else {
        if (runLength >= 5) score += 3 + runLength - 5;
        runColor = line[i];
        runLength = 1;
      }
    }
    if (runLength >= 5) score += 3 + runLength - 5;
    return score;
  };
  for (let i = 0; i < size; i += 1) {
    penalty += scoreLine(matrix[i]);
    penalty += scoreLine(matrix.map(row => row[i]));
  }
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const color = matrix[y][x];
      if (matrix[y][x + 1] === color && matrix[y + 1][x] === color && matrix[y + 1][x + 1] === color) {
        penalty += 3;
      }
    }
  }
  const pattern = "10111010000";
  const reverse = "00001011101";
  for (let y = 0; y < size; y += 1) {
    const row = matrix[y].map(Boolean).map(Number).join("");
    penalty += countPattern(row, pattern) * 40 + countPattern(row, reverse) * 40;
  }
  for (let x = 0; x < size; x += 1) {
    const column = matrix.map(row => Number(row[x])).join("");
    penalty += countPattern(column, pattern) * 40 + countPattern(column, reverse) * 40;
  }
  const dark = matrix.flat().filter(Boolean).length;
  const percent = (dark * 100) / (size * size);
  penalty += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return penalty;
}

function countPattern(text, pattern) {
  let count = 0;
  for (let index = text.indexOf(pattern); index !== -1; index = text.indexOf(pattern, index + 1)) {
    count += 1;
  }
  return count;
}

function cloneMatrix(matrix) {
  return matrix.map(row => row.slice());
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(text) {
  const normalized = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function streamBytes(bytes, stream) {
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}
