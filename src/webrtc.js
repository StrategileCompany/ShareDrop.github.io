const RTC_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};
const PROTOCOL = "meshdrop-webrtc-v1";
const HEARTBEAT_INTERVAL = 5000;
const PEER_TIMEOUT = 16000;
const MESSAGE_TTL = 8;

export class PeerNetwork extends EventTarget {
  constructor({ peerId, name, storage }) {
    super();
    this.localPeer = { id: peerId, name };
    this.storage = storage;
    this.sessions = new Map();
    this.pendingOffers = new Map();
    this.autoAttempts = new Set();
    this.peers = new Map();
    this.seenMessages = new Set();
    this.heartbeatTimer = window.setInterval(() => this.tick(), HEARTBEAT_INTERVAL);
  }

  setName(name) {
    this.localPeer.name = name;
    this.broadcastHello();
  }

  async createOffer() {
    const offerId = crypto.randomUUID();
    const session = this.createSession({ remoteId: null, offerId, role: "offerer" });
    const channel = session.pc.createDataChannel("meshdrop", { ordered: true });
    this.attachChannel(session, channel);
    const offer = await session.pc.createOffer();
    await session.pc.setLocalDescription(offer);
    await waitForIceGathering(session.pc);
    this.pendingOffers.set(offerId, session);
    await this.storage?.saveSession?.({ id: offerId, mode: "offer", createdAt: Date.now() });
    return {
      protocol: PROTOCOL,
      mode: "offer",
      id: offerId,
      peer: this.publicPeer(),
      sdp: session.pc.localDescription
    };
  }

  async acceptOffer(payload) {
    this.assertPayload(payload, "offer");
    const remotePeer = payload.peer;
    const session = this.createSession({ remoteId: remotePeer.id, offerId: payload.id, role: "answerer" });
    this.rememberPeer(remotePeer, { connected: false, state: "connecting" });
    session.pc.ondatachannel = event => this.attachChannel(session, event.channel);
    await session.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    const answer = await session.pc.createAnswer();
    await session.pc.setLocalDescription(answer);
    await waitForIceGathering(session.pc);
    await this.storage?.saveSession?.({ id: payload.id, mode: "answer", remoteId: remotePeer.id, createdAt: Date.now() });
    return {
      protocol: PROTOCOL,
      mode: "answer",
      replyTo: payload.id,
      peer: this.publicPeer(),
      sdp: session.pc.localDescription
    };
  }

  async acceptAnswer(payload) {
    this.assertPayload(payload, "answer");
    const session = this.pendingOffers.get(payload.replyTo);
    if (!session) {
      throw new Error("Resposta recebida para um convite desconhecido ou já usado.");
    }
    session.remoteId = payload.peer.id;
    this.pendingOffers.delete(payload.replyTo);
    this.sessions.delete(session.key);
    session.key = payload.peer.id;
    this.sessions.set(session.key, session);
    this.rememberPeer(payload.peer, { connected: false, state: "connecting" });
    await session.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    this.dispatchPeers();
  }

  sendChat({ to = "all", text }) {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const envelope = {
      id: crypto.randomUUID(),
      type: to === "all" ? "message" : "private-message",
      from: this.localPeer.id,
      to,
      text: trimmed,
      timestamp: Date.now(),
      ttl: MESSAGE_TTL
    };
    this.recordMessage(envelope, true);
    this.forward(envelope);
  }

  broadcastHello() {
    this.forward({
      id: crypto.randomUUID(),
      type: "hello",
      from: this.localPeer.id,
      peer: this.publicPeer(),
      timestamp: Date.now(),
      ttl: MESSAGE_TTL
    });
    this.broadcastPeerList();
  }

  broadcastPeerList() {
    this.forward({
      id: crypto.randomUUID(),
      type: "peer-list",
      from: this.localPeer.id,
      peers: [this.publicPeer(), ...this.getPeers()],
      timestamp: Date.now(),
      ttl: MESSAGE_TTL
    });
  }

  getPeers() {
    const now = Date.now();
    return Array.from(this.peers.values())
      .map(peer => ({
        ...peer,
        connected: this.isDirectlyConnected(peer.id),
        stale: now - (peer.lastSeen ?? 0) > PEER_TIMEOUT
      }))
      .sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name));
  }

  close() {
    window.clearInterval(this.heartbeatTimer);
    for (const session of this.sessions.values()) {
      this.notifyDisconnect(session.remoteId);
      session.channel?.close();
      session.pc.close();
    }
  }

  createSession({ remoteId, offerId, role }) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const key = remoteId ?? `pending:${offerId}`;
    const session = {
      key,
      remoteId,
      offerId,
      role,
      pc,
      channel: null,
      state: "connecting",
      retryCount: 0,
      pendingPings: new Map()
    };
    pc.onconnectionstatechange = () => this.updateSessionState(session);
    pc.oniceconnectionstatechange = () => this.updateSessionState(session);
    this.sessions.set(key, session);
    return session;
  }

  attachChannel(session, channel) {
    session.channel = channel;
    channel.onopen = () => {
      session.state = "connected";
      session.retryCount = 0;
      this.sendToSession(session, {
        id: crypto.randomUUID(),
        type: "hello",
        from: this.localPeer.id,
        peer: this.publicPeer(),
        timestamp: Date.now(),
        ttl: MESSAGE_TTL
      });
      this.sendPeerListTo(session);
      this.dispatchStatus();
    };
    channel.onmessage = event => this.handleRawMessage(event.data, session);
    channel.onclose = () => this.handleSessionClosed(session);
    channel.onerror = () => this.handleSessionClosed(session);
  }

  handleRawMessage(data, session) {
    let envelope;
    try {
      envelope = JSON.parse(data);
    } catch {
      return;
    }
    if (!envelope || envelope.from === this.localPeer.id) {
      return;
    }
    if (envelope.peer) {
      this.rememberPeer(envelope.peer, { connected: this.isDirectlyConnected(envelope.peer.id), state: "online" });
      if (!session.remoteId) {
        this.promoteSession(session, envelope.peer.id);
      }
    }
    if (envelope.type === "heartbeat") {
      this.handleHeartbeat(envelope, session);
      return;
    }
    if (envelope.id && this.seenMessages.has(envelope.id)) {
      return;
    }
    if (envelope.id) {
      this.markSeen(envelope.id);
    }
    switch (envelope.type) {
      case "hello":
        this.sendPeerListTo(session);
        this.dispatchPeers();
        break;
      case "peer-list":
        this.handlePeerList(envelope);
        this.forward(envelope, session);
        break;
      case "mesh-offer":
        if (envelope.to === this.localPeer.id) {
          this.acceptMeshOffer(envelope);
        } else {
          this.forward(envelope, session);
        }
        break;
      case "mesh-answer":
        if (envelope.to === this.localPeer.id) {
          this.acceptMeshAnswer(envelope);
        } else {
          this.forward(envelope, session);
        }
        break;
      case "message":
        this.recordMessage(envelope, false);
        this.forward(envelope, session);
        break;
      case "private-message":
        if (envelope.to === this.localPeer.id) {
          this.recordMessage(envelope, false);
        } else {
          this.forward(envelope, session);
        }
        break;
      case "peer-disconnect":
        this.markPeerOffline(envelope.from);
        this.forward(envelope, session);
        break;
      default:
        break;
    }
  }

  handlePeerList(envelope) {
    for (const peer of envelope.peers ?? []) {
      if (!peer.id || peer.id === this.localPeer.id) {
        continue;
      }
      this.rememberPeer(peer, {
        connected: this.isDirectlyConnected(peer.id),
        state: peer.connected ? "online" : "seen"
      });
      this.maybeAutoConnect(peer.id);
    }
    this.dispatchPeers();
  }

  async maybeAutoConnect(remoteId) {
    if (!remoteId || remoteId === this.localPeer.id || this.isDirectlyConnected(remoteId) || this.sessionForPeer(remoteId)) {
      return;
    }
    if (this.localPeer.id > remoteId || this.autoAttempts.has(remoteId)) {
      return;
    }
    this.autoAttempts.add(remoteId);
    try {
      const offerId = `mesh-${crypto.randomUUID()}`;
      const session = this.createSession({ remoteId, offerId, role: "mesh-offer" });
      const channel = session.pc.createDataChannel("meshdrop", { ordered: true });
      this.attachChannel(session, channel);
      const offer = await session.pc.createOffer();
      await session.pc.setLocalDescription(offer);
      await waitForIceGathering(session.pc);
      this.pendingOffers.set(offerId, session);
      this.forward({
        id: offerId,
        type: "mesh-offer",
        from: this.localPeer.id,
        to: remoteId,
        peer: this.publicPeer(),
        sdp: session.pc.localDescription,
        timestamp: Date.now(),
        ttl: MESSAGE_TTL
      });
    } catch {
      this.autoAttempts.delete(remoteId);
    }
  }

  async acceptMeshOffer(envelope) {
    try {
      const remotePeer = envelope.peer;
      if (!remotePeer?.id || this.isDirectlyConnected(remotePeer.id)) {
        return;
      }
      const session = this.createSession({ remoteId: remotePeer.id, offerId: envelope.id, role: "mesh-answer" });
      this.rememberPeer(remotePeer, { connected: false, state: "connecting" });
      session.pc.ondatachannel = event => this.attachChannel(session, event.channel);
      await session.pc.setRemoteDescription(new RTCSessionDescription(envelope.sdp));
      const answer = await session.pc.createAnswer();
      await session.pc.setLocalDescription(answer);
      await waitForIceGathering(session.pc);
      this.forward({
        id: crypto.randomUUID(),
        type: "mesh-answer",
        from: this.localPeer.id,
        to: remotePeer.id,
        replyTo: envelope.id,
        peer: this.publicPeer(),
        sdp: session.pc.localDescription,
        timestamp: Date.now(),
        ttl: MESSAGE_TTL
      });
    } catch {
      this.markPeerOffline(envelope.from);
    }
  }

  async acceptMeshAnswer(envelope) {
    try {
      const session = this.pendingOffers.get(envelope.replyTo);
      if (!session) {
        return;
      }
      session.remoteId = envelope.peer.id;
      this.pendingOffers.delete(envelope.replyTo);
      await session.pc.setRemoteDescription(new RTCSessionDescription(envelope.sdp));
      this.rememberPeer(envelope.peer, { connected: false, state: "connecting" });
    } catch {
      this.markPeerOffline(envelope.from);
    }
  }

  handleHeartbeat(envelope, session) {
    if (envelope.kind === "ping") {
      this.sendToSession(session, {
        type: "heartbeat",
        kind: "pong",
        from: this.localPeer.id,
        to: envelope.from,
        replyTo: envelope.nonce,
        timestamp: Date.now()
      });
      return;
    }
    if (envelope.kind === "pong" && envelope.replyTo) {
      const sentAt = session.pendingPings.get(envelope.replyTo);
      if (sentAt) {
        session.pendingPings.delete(envelope.replyTo);
        const latency = Date.now() - sentAt;
        if (session.remoteId) {
          this.rememberPeer({ id: session.remoteId }, { latency, connected: true, state: "online" });
        }
      }
    }
  }

  forward(envelope, exceptSession = null) {
    const ttl = envelope.ttl ?? MESSAGE_TTL;
    if (ttl <= 0) {
      return;
    }
    const next = { ...envelope, ttl: ttl - 1 };
    const direct = envelope.to && envelope.to !== "all" ? this.sessionForPeer(envelope.to) : null;
    if (direct && direct !== exceptSession && this.isOpen(direct.channel)) {
      this.sendToSession(direct, next);
      return;
    }
    for (const session of this.sessions.values()) {
      if (session === exceptSession || !this.isOpen(session.channel)) {
        continue;
      }
      this.sendToSession(session, next);
    }
  }

  sendPeerListTo(session) {
    this.sendToSession(session, {
      id: crypto.randomUUID(),
      type: "peer-list",
      from: this.localPeer.id,
      peers: [this.publicPeer(), ...this.getPeers()],
      timestamp: Date.now(),
      ttl: MESSAGE_TTL
    });
  }

  sendToSession(session, payload) {
    if (!this.isOpen(session.channel)) {
      return false;
    }
    session.channel.send(JSON.stringify(payload));
    return true;
  }

  tick() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (!this.isOpen(session.channel)) {
        this.maybeRetry(session);
        continue;
      }
      const nonce = crypto.randomUUID();
      session.pendingPings.set(nonce, now);
      this.sendToSession(session, {
        type: "heartbeat",
        kind: "ping",
        nonce,
        from: this.localPeer.id,
        timestamp: now
      });
    }
    for (const peer of this.peers.values()) {
      if (peer.connected && now - (peer.lastSeen ?? 0) > PEER_TIMEOUT) {
        peer.connected = false;
        peer.state = "stale";
      }
    }
    this.dispatchPeers();
    this.dispatchStatus();
  }

  updateSessionState(session) {
    const state = session.pc.connectionState || session.pc.iceConnectionState;
    session.state = state;
    if (session.remoteId) {
      this.rememberPeer({ id: session.remoteId }, {
        connected: state === "connected",
        state,
        lastSeen: Date.now()
      });
    }
    if (["disconnected", "failed"].includes(state)) {
      this.maybeRetry(session);
    }
    this.dispatchStatus();
  }

  maybeRetry(session) {
    if (session.retryCount >= 3 || session.pc.signalingState === "closed") {
      if (session.remoteId) {
        this.markPeerOffline(session.remoteId);
      }
      return;
    }
    session.retryCount += 1;
    try {
      session.pc.restartIce?.();
    } catch {
      // restartIce is best-effort; disconnected peers can always be paired again manually.
    }
  }

  handleSessionClosed(session) {
    session.state = "closed";
    if (session.remoteId) {
      this.markPeerOffline(session.remoteId);
    }
    this.dispatchStatus();
  }

  promoteSession(session, remoteId) {
    this.sessions.delete(session.key);
    session.remoteId = remoteId;
    session.key = remoteId;
    this.sessions.set(remoteId, session);
  }

  sessionForPeer(peerId) {
    return this.sessions.get(peerId) ?? Array.from(this.sessions.values()).find(session => session.remoteId === peerId);
  }

  rememberPeer(peer, patch = {}) {
    const existing = this.peers.get(peer.id) ?? {};
    const next = {
      ...existing,
      ...peer,
      ...patch,
      id: peer.id,
      name: peer.name ?? existing.name ?? peer.id.slice(0, 6),
      lastSeen: patch.lastSeen ?? Date.now()
    };
    this.peers.set(next.id, next);
    this.storage?.savePeer?.(next);
    this.dispatchPeers();
  }

  markPeerOffline(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) {
      return;
    }
    peer.connected = false;
    peer.state = "offline";
    peer.lastSeen = Date.now();
    this.dispatchPeers();
  }

  notifyDisconnect(peerId) {
    if (!peerId) {
      return;
    }
    this.forward({
      id: crypto.randomUUID(),
      type: "peer-disconnect",
      from: this.localPeer.id,
      to: "all",
      peerId,
      timestamp: Date.now(),
      ttl: MESSAGE_TTL
    });
  }

  recordMessage(envelope, own) {
    const message = {
      id: envelope.id ?? crypto.randomUUID(),
      type: envelope.type,
      from: envelope.from,
      to: envelope.to,
      text: envelope.text,
      timestamp: envelope.timestamp ?? Date.now(),
      private: envelope.type === "private-message",
      own
    };
    this.storage?.saveMessage?.(message);
    this.dispatchEvent(new CustomEvent("message", { detail: message }));
  }

  publicPeer() {
    return {
      id: this.localPeer.id,
      name: this.localPeer.name,
      lastSeen: Date.now(),
      connected: true
    };
  }

  isOpen(channel) {
    return channel?.readyState === "open";
  }

  isDirectlyConnected(peerId) {
    return this.isOpen(this.sessionForPeer(peerId)?.channel);
  }

  dispatchPeers() {
    this.dispatchEvent(new CustomEvent("peers", { detail: this.getPeers() }));
  }

  dispatchStatus() {
    const direct = Array.from(this.sessions.values()).filter(session => this.isOpen(session.channel)).length;
    this.dispatchEvent(new CustomEvent("status", {
      detail: {
        direct,
        total: this.peers.size,
        online: direct > 0
      }
    }));
  }

  markSeen(id) {
    this.seenMessages.add(id);
    if (this.seenMessages.size > 800) {
      const first = this.seenMessages.values().next().value;
      this.seenMessages.delete(first);
    }
  }

  assertPayload(payload, mode) {
    if (payload?.protocol !== PROTOCOL || payload.mode !== mode || !payload.peer?.id || !payload.sdp) {
      throw new Error("SDP incompatível com este app.");
    }
  }
}

export function createPeerId() {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return `peer-${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function waitForIceGathering(pc) {
  if (pc.iceGatheringState === "complete") {
    return;
  }
  await new Promise(resolve => {
    const timeout = window.setTimeout(done, 4200);
    function done() {
      window.clearTimeout(timeout);
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }
    function onChange() {
      if (pc.iceGatheringState === "complete") {
        done();
      }
    }
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}
