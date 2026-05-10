const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const HEARTBEAT_INTERVAL = 5000;
const PEER_TIMEOUT = 16000;

export const MESSAGE_TYPES = {
  HELLO: "hello",
  PEER_LIST: "peer-list",
  HEARTBEAT: "heartbeat",
  MESSAGE: "message",
  PRIVATE_MESSAGE: "private-message",
  PEER_DISCONNECT: "peer-disconnect",
  MESH_SIGNAL: "mesh-signal"
};

export class WebRTCManager extends EventTarget {
  constructor({ peerId, getName }) {
    super();
    this.peerId = peerId;
    this.getName = getName;
    this.peers = new Map();
    this.pendingOffers = new Map();
    this.pendingAnswers = new Map();
    this.heartbeatTimer = window.setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL);
  }

  get connectedPeers() {
    return [...this.peers.values()].map((peer) => this.serializePeer(peer));
  }

  serializePeer(peer) {
    return {
      id: peer.id,
      name: peer.name || "Dispositivo",
      status: peer.status,
      latency: peer.latency || null,
      lastSeen: peer.lastSeen || Date.now(),
      direct: peer.channel?.readyState === "open"
    };
  }

  async createOffer() {
    const sessionId = crypto.randomUUID();
    const connection = this.createPeerConnection(null, sessionId, true);
    const channel = connection.createDataChannel("sharedrop", { ordered: true });
    this.prepareDataChannel(channel, null, sessionId);
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await this.waitForIceGathering(connection);
    this.pendingOffers.set(sessionId, connection);
    this.emit("log", "Convite SDP criado.");
    return this.makeSignal("offer", sessionId, connection.localDescription);
  }

  async acceptOffer(payload) {
    this.ensureSignal(payload, "offer");
    const connection = this.createPeerConnection(payload.from.id, payload.sessionId, false);
    connection.ondatachannel = (event) => {
      this.prepareDataChannel(event.channel, payload.from.id, payload.sessionId);
    };
    await connection.setRemoteDescription(payload.sdp);
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    await this.waitForIceGathering(connection);
    this.pendingAnswers.set(payload.sessionId, connection);
    this.upsertPeer(payload.from, { connection, status: "connecting" });
    this.emit("log", `Resposta SDP criada para ${payload.from.name}.`);
    return this.makeSignal("answer", payload.sessionId, connection.localDescription, payload.from.id);
  }

  async acceptAnswer(payload) {
    this.ensureSignal(payload, "answer");
    const connection = this.pendingOffers.get(payload.sessionId);
    if (!connection) {
      throw new Error("Não encontrei o convite original para essa resposta.");
    }
    await connection.setRemoteDescription(payload.sdp);
    this.pendingOffers.delete(payload.sessionId);
    this.emit("log", `Resposta SDP aplicada de ${payload.from.name}.`);
  }

  async processSignal(rawSignal) {
    const payload = decodeSignal(rawSignal);
    if (payload.from?.id === this.peerId) {
      throw new Error("Esse SDP foi gerado por este próprio dispositivo.");
    }
    if (payload.kind === "offer") return this.acceptOffer(payload);
    if (payload.kind === "answer") {
      await this.acceptAnswer(payload);
      return null;
    }
    throw new Error("Tipo de SDP desconhecido.");
  }

  createPeerConnection(remoteId, sessionId, polite) {
    const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    connection.__sessionId = sessionId;
    connection.__remoteId = remoteId;
    connection.__polite = polite;
    connection.onconnectionstatechange = () => this.handleConnectionState(connection);
    connection.oniceconnectionstatechange = () => this.handleConnectionState(connection);
    return connection;
  }

  prepareDataChannel(channel, remoteId, sessionId) {
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      const peer = this.findPeer(remoteId, sessionId);
      peer.channel = channel;
      peer.status = "online";
      peer.lastSeen = Date.now();
      this.sendTo(peer.id, {
        type: MESSAGE_TYPES.HELLO,
        from: this.peerId,
        to: peer.id,
        name: this.getName(),
        timestamp: Date.now()
      });
      this.broadcastPeerList();
      this.emitPeers();
      this.emit("log", `Canal aberto com ${peer.name || peer.id.slice(0, 8)}.`);
    };
    channel.onmessage = (event) => this.handleMessage(event.data, remoteId, sessionId);
    channel.onclose = () => this.markChannelClosed(remoteId, sessionId, "canal fechado");
    channel.onerror = () => this.markChannelClosed(remoteId, sessionId, "erro no canal");
  }

  findPeer(remoteId, sessionId) {
    if (remoteId && this.peers.has(remoteId)) return this.peers.get(remoteId);
    const match = [...this.peers.values()].find((peer) => peer.connection?.__sessionId === sessionId);
    if (match) return match;
    const id = remoteId || `pending-${sessionId}`;
    return this.upsertPeer({ id, name: "Pareando" }, { status: "connecting" });
  }

  upsertPeer(identity, extra = {}) {
    if (!identity?.id || identity.id === this.peerId) return null;
    const existing = this.peers.get(identity.id) || {};
    const peer = {
      ...existing,
      ...extra,
      id: identity.id,
      name: identity.name || existing.name || "Dispositivo",
      status: extra.status || existing.status || "known",
      lastSeen: Date.now()
    };
    if (existing.id?.startsWith("pending-") && existing.id !== identity.id) {
      this.peers.delete(existing.id);
    }
    this.peers.set(peer.id, peer);
    this.emitPeers();
    return peer;
  }

  peerForSession(remoteId, sessionId) {
    if (remoteId && this.peers.has(remoteId)) return this.peers.get(remoteId);
    return [...this.peers.values()].find((peer) => peer.connection?.__sessionId === sessionId);
  }

  rekeyPendingPeer(oldId, identity, sessionId) {
    if (oldId === identity.id) return this.upsertPeer(identity);
    const pending = this.peers.get(oldId) || [...this.peers.values()].find((peer) => peer.connection?.__sessionId === sessionId);
    if (pending) this.peers.delete(pending.id);
    if (pending?.connection) pending.connection.__remoteId = identity.id;
    return this.upsertPeer(identity, pending || {});
  }

  handleMessage(raw, remoteId, sessionId) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message?.type || message.from === this.peerId) return;

    const peer = this.rekeyPendingPeer(remoteId || message.from, {
      id: message.from,
      name: message.name || this.peers.get(message.from)?.name || "Dispositivo"
    }, sessionId);
    if (peer) {
      peer.lastSeen = Date.now();
      peer.status = "online";
    }

    switch (message.type) {
      case MESSAGE_TYPES.HELLO:
        this.sendTo(message.from, {
          type: MESSAGE_TYPES.PEER_LIST,
          from: this.peerId,
          to: message.from,
          peers: this.localPeerList(),
          timestamp: Date.now()
        });
        this.broadcastPeerList();
        break;
      case MESSAGE_TYPES.PEER_LIST:
        this.learnPeerList(message.peers || [], message.from);
        break;
      case MESSAGE_TYPES.HEARTBEAT:
        this.handleHeartbeat(message, peer);
        break;
      case MESSAGE_TYPES.MESSAGE:
      case MESSAGE_TYPES.PRIVATE_MESSAGE:
        this.emit("message", message);
        this.relayIfNeeded(message);
        break;
      case MESSAGE_TYPES.PEER_DISCONNECT:
        this.markDisconnected(message.from, "peer saiu");
        this.relayIfNeeded(message);
        break;
      case MESSAGE_TYPES.MESH_SIGNAL:
        this.handleMeshSignal(message);
        break;
      default:
        break;
    }
    this.emitPeers();
  }

  handleHeartbeat(message, peer) {
    if (message.replyTo && peer) {
      peer.latency = Math.max(1, Date.now() - message.replyTo);
      return;
    }
    this.sendTo(message.from, {
      type: MESSAGE_TYPES.HEARTBEAT,
      from: this.peerId,
      to: message.from,
      timestamp: Date.now(),
      replyTo: message.timestamp
    });
  }

  learnPeerList(peers, via) {
    let changed = false;
    for (const peer of peers) {
      if (!peer?.id || peer.id === this.peerId) continue;
      const existing = this.peers.get(peer.id);
      if (!existing) {
        this.upsertPeer(peer, { status: peer.direct ? "online" : "known", via });
        changed = true;
      } else if (peer.name && existing.name !== peer.name) {
        existing.name = peer.name;
        changed = true;
      }
    }
    if (changed) {
      this.broadcastPeerList();
      this.emitPeers();
    }
  }

  async handleMeshSignal(message) {
    if (message.to !== this.peerId) {
      this.forward(message);
      return;
    }
    try {
      if (message.signal?.kind === "offer") {
        const answer = await this.acceptOffer(message.signal);
        this.forward({
          type: MESSAGE_TYPES.MESH_SIGNAL,
          from: this.peerId,
          to: message.from,
          signal: answer,
          timestamp: Date.now()
        });
      } else if (message.signal?.kind === "answer") {
        await this.acceptAnswer(message.signal);
      }
    } catch (error) {
      this.emit("log", error.message);
    }
  }

  requestMesh(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer || peer.channel?.readyState === "open") return;
    return this.createOffer().then((signal) => {
      signal.to = peerId;
      this.forward({
        type: MESSAGE_TYPES.MESH_SIGNAL,
        from: this.peerId,
        to: peerId,
        signal,
        timestamp: Date.now()
      });
    });
  }

  sendMessage(text, to = "all") {
    const type = to === "all" ? MESSAGE_TYPES.MESSAGE : MESSAGE_TYPES.PRIVATE_MESSAGE;
    const message = {
      type,
      from: this.peerId,
      to,
      text,
      timestamp: Date.now()
    };
    if (to === "all") {
      this.broadcast(message);
    } else {
      this.sendTo(to, message) || this.forward(message);
    }
    return message;
  }

  broadcast(message) {
    for (const peer of this.peers.values()) {
      if (peer.channel?.readyState === "open") {
        peer.channel.send(JSON.stringify(message));
      }
    }
  }

  sendTo(peerId, message) {
    const peer = this.peers.get(peerId);
    if (peer?.channel?.readyState === "open") {
      peer.channel.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  forward(message) {
    const payload = JSON.stringify(message);
    for (const peer of this.peers.values()) {
      if (peer.channel?.readyState === "open" && peer.id !== message.from) {
        peer.channel.send(payload);
      }
    }
  }

  relayIfNeeded(message) {
    if (message.to === "all") {
      this.forward(message);
    } else if (message.to !== this.peerId) {
      this.sendTo(message.to, message) || this.forward(message);
    }
  }

  localPeerList() {
    return [
      {
        id: this.peerId,
        name: this.getName(),
        status: "online",
        direct: true,
        lastSeen: Date.now()
      },
      ...this.connectedPeers
    ];
  }

  broadcastPeerList() {
    this.broadcast({
      type: MESSAGE_TYPES.PEER_LIST,
      from: this.peerId,
      to: "all",
      peers: this.localPeerList(),
      timestamp: Date.now()
    });
  }

  heartbeat() {
    const now = Date.now();
    for (const peer of this.peers.values()) {
      if (peer.channel?.readyState === "open") {
        this.sendTo(peer.id, {
          type: MESSAGE_TYPES.HEARTBEAT,
          from: this.peerId,
          to: peer.id,
          timestamp: now
        });
      }
      if (peer.status === "online" && now - (peer.lastSeen || 0) > PEER_TIMEOUT) {
        peer.status = "stale";
      }
      if (["known", "stale", "offline"].includes(peer.status) && this.hasOpenRoute(peer.id) && (!peer.lastMeshAttempt || now - peer.lastMeshAttempt > 12000)) {
        peer.lastMeshAttempt = now;
        this.requestMesh(peer.id);
      }
    }
    this.emitPeers();
  }

  hasOpenRoute(exceptPeerId) {
    return [...this.peers.values()].some((peer) => peer.id !== exceptPeerId && peer.channel?.readyState === "open");
  }

  markChannelClosed(remoteId, sessionId, reason) {
    const peer = this.peerForSession(remoteId, sessionId);
    if (peer) this.markDisconnected(peer.id, reason);
  }

  markDisconnected(peerId, reason) {
    if (!peerId) return;
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.status = "offline";
    peer.lastSeen = Date.now();
    this.emit("log", `${peer.name || peerId.slice(0, 8)} desconectado: ${reason}.`);
    this.broadcast({
      type: MESSAGE_TYPES.PEER_DISCONNECT,
      from: peerId,
      to: "all",
      timestamp: Date.now()
    });
    this.emitPeers();
  }

  handleConnectionState(connection) {
    const peer = [...this.peers.values()].find((item) => item.connection === connection);
    if (!peer) return;
    const state = connection.connectionState || connection.iceConnectionState;
    if (["failed", "disconnected", "closed"].includes(state)) {
      this.markDisconnected(peer.id, state);
    } else if (["connected", "completed"].includes(state)) {
      peer.status = "online";
      peer.lastSeen = Date.now();
      this.emitPeers();
    }
  }

  waitForIceGathering(connection) {
    if (connection.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const timeout = window.setTimeout(resolve, 4200);
      connection.addEventListener("icegatheringstatechange", () => {
        if (connection.iceGatheringState === "complete") {
          window.clearTimeout(timeout);
          resolve();
        }
      });
    });
  }

  makeSignal(kind, sessionId, sdp, to = null) {
    return {
      app: "sharedrop",
      version: 1,
      kind,
      sessionId,
      from: {
        id: this.peerId,
        name: this.getName()
      },
      to,
      sdp: {
        type: sdp.type,
        sdp: sdp.sdp
      },
      timestamp: Date.now()
    };
  }

  ensureSignal(payload, kind) {
    if (!payload || payload.app !== "sharedrop" || payload.kind !== kind || !payload.sdp) {
      throw new Error(`SDP ${kind} inválido.`);
    }
  }

  disconnect() {
    this.broadcast({
      type: MESSAGE_TYPES.PEER_DISCONNECT,
      from: this.peerId,
      to: "all",
      timestamp: Date.now()
    });
    window.clearInterval(this.heartbeatTimer);
    for (const peer of this.peers.values()) {
      peer.channel?.close();
      peer.connection?.close();
    }
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  emitPeers() {
    this.emit("peers", this.connectedPeers);
  }
}

export function encodeSignal(signal) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(signal))));
}

export function decodeSignal(rawSignal) {
  const clean = String(rawSignal || "").trim();
  if (!clean) throw new Error("Cole ou escaneie um SDP primeiro.");
  try {
    return JSON.parse(clean);
  } catch {
    try {
      return JSON.parse(decodeURIComponent(escape(atob(clean))));
    } catch {
      throw new Error("Não consegui ler esse SDP.");
    }
  }
}
