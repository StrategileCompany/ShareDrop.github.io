import { PairingPayloadCodec, QRRotator, QRScanner } from "./qr.js";
import { LocalStore } from "./storage.js";
import { PeerNetwork, createPeerId } from "./webrtc.js";

const $ = selector => document.querySelector(selector);
const state = {
  store: new LocalStore(),
  network: null,
  peerId: createPeerId(),
  deviceName: "",
  messages: [],
  activeCleanup: null,
  installPrompt: null
};

const elements = {
  deviceTitle: $("#deviceTitle"),
  deviceSubtitle: $("#deviceSubtitle"),
  connectionStatus: $("#connectionStatus"),
  setupPanel: $("#setupPanel"),
  deviceNameInput: $("#deviceNameInput"),
  saveNameButton: $("#saveNameButton"),
  settingsButton: $("#settingsButton"),
  installButton: $("#installButton"),
  createOfferButton: $("#createOfferButton"),
  scanButton: $("#scanButton"),
  pasteButton: $("#pasteButton"),
  peerGrid: $("#peerGrid"),
  peerCount: $("#peerCount"),
  messageList: $("#messageList"),
  messageForm: $("#messageForm"),
  recipientSelect: $("#recipientSelect"),
  messageInput: $("#messageInput"),
  clearHistoryButton: $("#clearHistoryButton"),
  pairDialog: $("#pairDialog"),
  pairDialogTitle: $("#pairDialogTitle"),
  pairDialogEyebrow: $("#pairDialogEyebrow"),
  pairDialogBody: $("#pairDialogBody"),
  toastStack: $("#toastStack")
};

window.addEventListener("DOMContentLoaded", init);
window.addEventListener("beforeunload", () => state.network?.close());
window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  state.installPrompt = event;
  elements.installButton.hidden = false;
});

async function init() {
  registerServiceWorker();
  const storedName = await state.store.getSetting("deviceName");
  state.deviceName = storedName || "";
  elements.deviceNameInput.value = state.deviceName;
  createNetwork(state.deviceName || "Dispositivo sem nome");
  state.messages = await state.store.getMessages();
  const recentPeers = await state.store.getRecentPeers();
  for (const peer of recentPeers) {
    if (peer.id !== state.peerId) {
      state.network.rememberPeer(peer, { connected: false, state: "visto" });
    }
  }
  bindEvents();
  renderIdentity();
  renderMessages();
  renderPeers(state.network.getPeers());
}

function createNetwork(name) {
  state.network = new PeerNetwork({ peerId: state.peerId, name, storage: state.store });
  state.network.addEventListener("peers", event => renderPeers(event.detail));
  state.network.addEventListener("status", event => renderStatus(event.detail));
  state.network.addEventListener("message", event => {
    state.messages.push(event.detail);
    state.messages = state.messages.slice(-160);
    renderMessages();
  });
}

function bindEvents() {
  elements.saveNameButton.addEventListener("click", saveDeviceName);
  elements.settingsButton.addEventListener("click", () => {
    elements.setupPanel.classList.toggle("hidden");
    elements.deviceNameInput.focus();
  });
  elements.installButton.addEventListener("click", async () => {
    if (!state.installPrompt) {
      return;
    }
    state.installPrompt.prompt();
    await state.installPrompt.userChoice;
    state.installPrompt = null;
    elements.installButton.hidden = true;
  });
  elements.createOfferButton.addEventListener("click", createOfferFlow);
  elements.scanButton.addEventListener("click", scanFlow);
  elements.pasteButton.addEventListener("click", pasteFlow);
  elements.messageForm.addEventListener("submit", event => {
    event.preventDefault();
    state.network.sendChat({
      to: elements.recipientSelect.value,
      text: elements.messageInput.value
    });
    elements.messageInput.value = "";
  });
  elements.clearHistoryButton.addEventListener("click", async () => {
    await state.store.clearMessages();
    state.messages = [];
    renderMessages();
    toast("Histórico limpo neste dispositivo.");
  });
  elements.pairDialog.addEventListener("close", () => {
    state.activeCleanup?.();
    state.activeCleanup = null;
  });
}

async function saveDeviceName() {
  const name = elements.deviceNameInput.value.trim() || fallbackName();
  state.deviceName = name;
  await state.store.setSetting("deviceName", name);
  state.network.setName(name);
  elements.setupPanel.classList.add("hidden");
  renderIdentity();
  toast("Nome do dispositivo salvo.");
}

async function createOfferFlow() {
  if (!(await ensureName())) {
    return;
  }
  setBusy(elements.createOfferButton, true);
  try {
    const payload = await state.network.createOffer();
    await showPayload(payload, {
      title: "Convite WebRTC",
      eyebrow: "QR de pareamento",
      status: "Escaneie no outro dispositivo. Depois cole ou escaneie a resposta aqui."
    });
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(elements.createOfferButton, false);
  }
}

async function scanFlow() {
  if (!(await ensureName())) {
    return;
  }
  const fragment = $("#scanTemplate").content.cloneNode(true);
  const video = fragment.querySelector(".scanner-video");
  const status = fragment.querySelector(".scanStatus");
  const stopButton = fragment.querySelector(".stopScanButton");
  openDialog({ title: "Escanear QR", eyebrow: "Câmera", body: fragment });

  const scanner = new QRScanner(video);
  state.activeCleanup = () => scanner.stop();
  stopButton.addEventListener("click", () => elements.pairDialog.close());
  scanner.addEventListener("progress", event => {
    status.textContent = `Lendo partes ${event.detail.done}/${event.detail.total}...`;
  });
  scanner.addEventListener("payload", async event => {
    scanner.stop();
    await processEncodedPayload(event.detail);
  });
  scanner.addEventListener("error", event => {
    toast(event.detail?.message || "Não foi possível ler o QR.", "error");
  });
  try {
    await scanner.start();
  } catch (error) {
    status.textContent = "Leitura por câmera indisponível neste navegador.";
    toast(error.message, "error");
  }
}

function pasteFlow() {
  const fragment = $("#pasteTemplate").content.cloneNode(true);
  const textarea = fragment.querySelector(".pastePayload");
  const readClipboardButton = fragment.querySelector(".readClipboardButton");
  const processPayloadButton = fragment.querySelector(".processPayloadButton");
  openDialog({ title: "Colar SDP", eyebrow: "Manual", body: fragment });

  readClipboardButton.addEventListener("click", async () => {
    try {
      textarea.value = await navigator.clipboard.readText();
      toast("Conteúdo lido do clipboard.");
    } catch {
      toast("Clipboard bloqueado pelo navegador.", "error");
    }
  });
  processPayloadButton.addEventListener("click", () => processEncodedPayload(textarea.value));
}

async function showPayload(payload, { title, eyebrow, status }) {
  const encoded = await PairingPayloadCodec.encode(payload);
  const chunks = PairingPayloadCodec.chunk(encoded);
  const fragment = $("#qrTemplate").content.cloneNode(true);
  const canvas = fragment.querySelector(".qr-canvas");
  const qrStatus = fragment.querySelector(".qrStatus");
  const manualPayload = fragment.querySelector(".manualPayload");
  const progress = fragment.querySelector(".progress-line span");
  const copyButton = fragment.querySelector(".copyPayloadButton");
  const stopButton = fragment.querySelector(".stopQrButton");

  manualPayload.value = encoded;
  qrStatus.textContent = status;
  copyButton.addEventListener("click", () => copyText(encoded));
  stopButton.addEventListener("click", () => elements.pairDialog.close());
  openDialog({ title, eyebrow, body: fragment });

  const rotator = new QRRotator(canvas, chunks, {
    onFrame: (index, total) => {
      progress.style.width = `${(index / total) * 100}%`;
      qrStatus.textContent = total === 1
        ? status
        : `${status} Parte ${index}/${total}.`;
    }
  });
  state.activeCleanup = () => rotator.stop();
  rotator.start();
}

async function processEncodedPayload(rawValue) {
  try {
    const payload = await PairingPayloadCodec.decode(rawValue);
    if (payload.mode === "offer") {
      setDialogLoading("Gerando resposta WebRTC...");
      const answer = await state.network.acceptOffer(payload);
      await showPayload(answer, {
        title: "Resposta WebRTC",
        eyebrow: "Retorno de pareamento",
        status: "Escaneie ou copie esta resposta no dispositivo que criou o convite."
      });
      toast("Convite aceito. Envie a resposta para finalizar.");
      return;
    }
    if (payload.mode === "answer") {
      setDialogLoading("Finalizando conexão...");
      await state.network.acceptAnswer(payload);
      elements.pairDialog.close();
      toast("Conexão WebRTC estabelecida.");
      return;
    }
    throw new Error("Modo de pareamento desconhecido.");
  } catch (error) {
    toast(error.message || "Payload inválido.", "error");
  }
}

function renderIdentity() {
  const name = state.deviceName || "Pronto para parear";
  elements.deviceTitle.textContent = name;
  elements.deviceSubtitle.textContent = `Peer ID temporário: ${state.peerId}`;
  elements.setupPanel.classList.toggle("hidden", Boolean(state.deviceName));
}

function renderStatus(status = { direct: 0, online: false }) {
  elements.connectionStatus.textContent = status.online
    ? `${status.direct} direto${status.direct > 1 ? "s" : ""}`
    : "aguardando";
  elements.connectionStatus.classList.toggle("online", status.online);
}

function renderPeers(peers) {
  const list = peers.filter(peer => peer.id !== state.peerId);
  elements.peerCount.textContent = String(list.filter(peer => peer.connected).length);
  elements.peerGrid.replaceChildren();
  elements.recipientSelect.replaceChildren(new Option("Todos", "all"));

  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Nenhum dispositivo conectado ainda.";
    elements.peerGrid.append(empty);
    return;
  }

  for (const peer of list) {
    elements.recipientSelect.append(new Option(peer.name, peer.id));
    const card = document.createElement("div");
    card.className = "peer-card";
    card.innerHTML = `
      <div class="peer-avatar">${initials(peer.name)}</div>
      <div>
        <div class="peer-name"></div>
        <div class="peer-meta"></div>
      </div>
      <div class="latency"></div>
    `;
    card.querySelector(".peer-name").textContent = peer.name;
    card.querySelector(".peer-meta").textContent = `${peer.connected ? "online" : peer.state || "visto"} · ${peer.id.slice(0, 11)}`;
    card.querySelector(".latency").textContent = peer.latency ? `~${peer.latency} ms` : "n/a";
    elements.peerGrid.append(card);
  }
}

function renderMessages() {
  elements.messageList.replaceChildren();
  if (state.messages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "As mensagens recebidas aparecem aqui.";
    elements.messageList.append(empty);
    return;
  }
  for (const message of state.messages.slice(-120)) {
    const item = document.createElement("div");
    item.className = `message${message.own ? " own" : ""}${message.private ? " private" : ""}`;
    const sender = message.own ? "Você" : peerName(message.from);
    const target = message.to === "all" ? "todos" : peerName(message.to);
    item.innerHTML = `
      <div class="message-meta"></div>
      <p class="message-text"></p>
    `;
    item.querySelector(".message-meta").textContent = `${sender} → ${target} · ${formatTime(message.timestamp)}`;
    item.querySelector(".message-text").textContent = message.text;
    elements.messageList.append(item);
  }
  elements.messageList.scrollTop = elements.messageList.scrollHeight;
}

function openDialog({ title, eyebrow, body }) {
  state.activeCleanup?.();
  state.activeCleanup = null;
  elements.pairDialogTitle.textContent = title;
  elements.pairDialogEyebrow.textContent = eyebrow;
  elements.pairDialogBody.replaceChildren(body);
  if (!elements.pairDialog.open) {
    elements.pairDialog.showModal();
  }
}

function setDialogLoading(text) {
  const loading = document.createElement("div");
  loading.className = "empty-state";
  loading.textContent = text;
  elements.pairDialogBody.replaceChildren(loading);
}

async function ensureName() {
  if (state.deviceName) {
    return true;
  }
  elements.setupPanel.classList.remove("hidden");
  elements.deviceNameInput.focus();
  toast("Defina um nome para este dispositivo primeiro.");
  return false;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("SDP copiado para o clipboard.");
  } catch {
    toast("Não foi possível copiar automaticamente.", "error");
  }
}

function toast(message, type = "info") {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  elements.toastStack.append(node);
  window.setTimeout(() => node.remove(), 4200);
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.dataset.originalText ||= button.textContent;
  button.textContent = busy ? "Aguarde..." : button.dataset.originalText;
}

function peerName(peerId) {
  if (peerId === state.peerId) {
    return "Você";
  }
  return state.network.peers.get(peerId)?.name ?? peerId?.slice(0, 8) ?? "desconhecido";
}

function initials(name) {
  return (name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase())
    .join("") || "?";
}

function fallbackName() {
  const suffix = state.peerId.slice(-4).toUpperCase();
  return `Dispositivo ${suffix}`;
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      toast("Service worker indisponível neste contexto.", "error");
    });
  }
}
