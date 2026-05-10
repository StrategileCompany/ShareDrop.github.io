import { QRTools } from "./qr.js";
import { SharedropStore } from "./storage.js";
import { WebRTCManager, encodeSignal } from "./webrtc.js";

const $ = (selector) => document.querySelector(selector);
const store = new SharedropStore();
const peerId = crypto.randomUUID();

const state = {
  deviceName: "",
  selectedPeer: "all",
  lastSignal: "",
  deferredInstallPrompt: null,
  messages: []
};

const dom = {
  networkStatus: $("#networkStatus"),
  deviceTitle: $("#deviceTitle"),
  peerIdLabel: $("#peerIdLabel"),
  editNameButton: $("#editNameButton"),
  installCard: $("#installCard"),
  installButton: $("#installButton"),
  peerGrid: $("#peerGrid"),
  recipientSelect: $("#recipientSelect"),
  messageInput: $("#messageInput"),
  sendButton: $("#sendButton"),
  broadcastFocusButton: $("#broadcastFocusButton"),
  messageList: $("#messageList"),
  clearHistoryButton: $("#clearHistoryButton"),
  createOfferButton: $("#createOfferButton"),
  scanButton: $("#scanButton"),
  stopScanButton: $("#stopScanButton"),
  cameraPanel: $("#cameraPanel"),
  cameraVideo: $("#cameraVideo"),
  qrBox: $("#qrBox"),
  qrImage: $("#qrImage"),
  qrTitle: $("#qrTitle"),
  qrHint: $("#qrHint"),
  signalTextarea: $("#signalTextarea"),
  copySignalButton: $("#copySignalButton"),
  pasteSignalButton: $("#pasteSignalButton"),
  processSignalButton: $("#processSignalButton"),
  connectionLog: $("#connectionLog"),
  nameDialog: $("#nameDialog"),
  deviceNameInput: $("#deviceNameInput"),
  saveNameButton: $("#saveNameButton"),
  toastStack: $("#toastStack")
};

const rtc = new WebRTCManager({
  peerId,
  getName: () => state.deviceName
});

const qr = new QRTools(dom.cameraVideo);

boot();

async function boot() {
  state.deviceName = await store.getDeviceName() || makeDefaultName();
  await store.saveSession({ id: peerId, name: state.deviceName, startedAt: Date.now() });
  state.messages = (await store.all("messages", "timestamp")).slice(-80);
  renderIdentity();
  renderMessages();
  bindEvents();
  registerServiceWorker();
  log("Aplicativo pronto para pareamento local.");
  if (!await store.getDeviceName()) {
    openNameDialog();
  }
}

function bindEvents() {
  rtc.addEventListener("peers", async (event) => {
    renderPeers(event.detail);
    renderRecipientOptions(event.detail);
    for (const peer of event.detail) {
      await store.savePeer(peer);
    }
    updateNetworkStatus(event.detail);
  });
  rtc.addEventListener("message", async (event) => {
    await addMessage(event.detail);
    toast(`Mensagem de ${peerName(event.detail.from)}`);
  });
  rtc.addEventListener("log", (event) => log(event.detail));

  qr.addEventListener("scan", async (event) => {
    dom.signalTextarea.value = event.detail;
    toast("QRCode lido.");
    await processSignal();
  });
  qr.addEventListener("error", (event) => toast(event.detail.message || "Falha ao ler QRCode."));

  dom.editNameButton.addEventListener("click", openNameDialog);
  dom.saveNameButton.addEventListener("click", saveDeviceName);
  dom.createOfferButton.addEventListener("click", createOffer);
  dom.processSignalButton.addEventListener("click", processSignal);
  dom.copySignalButton.addEventListener("click", copySignal);
  dom.pasteSignalButton.addEventListener("click", pasteSignal);
  dom.scanButton.addEventListener("click", startScan);
  dom.stopScanButton.addEventListener("click", stopScan);
  dom.sendButton.addEventListener("click", sendMessage);
  dom.messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) sendMessage();
  });
  dom.recipientSelect.addEventListener("change", () => {
    state.selectedPeer = dom.recipientSelect.value;
    renderPeers(rtc.connectedPeers);
  });
  dom.broadcastFocusButton.addEventListener("click", () => {
    state.selectedPeer = "all";
    dom.recipientSelect.value = "all";
    dom.messageInput.focus();
    renderPeers(rtc.connectedPeers);
  });
  dom.clearHistoryButton.addEventListener("click", clearHistory);
  window.addEventListener("beforeunload", () => rtc.disconnect());
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
    dom.installCard.hidden = false;
  });
  dom.installButton.addEventListener("click", installPwa);
}

function renderIdentity() {
  dom.deviceTitle.textContent = state.deviceName;
  dom.peerIdLabel.textContent = `ID ${peerId.slice(0, 8)}`;
  dom.deviceNameInput.value = state.deviceName;
}

function renderPeers(peers = []) {
  dom.peerGrid.textContent = "";
  const online = peers.filter((peer) => peer.status !== "offline");
  if (online.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Nenhum dispositivo conectado. Gere um convite ou escaneie um QRCode para começar.";
    dom.peerGrid.append(empty);
    return;
  }
  for (const peer of online) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `peer-card ${state.selectedPeer === peer.id ? "selected" : ""}`;
    card.innerHTML = `
      <span class="peer-avatar">${initials(peer.name)}</span>
      <span class="peer-name"></span>
      <span class="peer-meta"></span>
    `;
    card.querySelector(".peer-name").textContent = peer.name;
    card.querySelector(".peer-meta").textContent = `${statusLabel(peer)} · ${peer.latency ? `${peer.latency} ms` : "latência n/d"}`;
    card.addEventListener("click", () => {
      state.selectedPeer = peer.id;
      dom.recipientSelect.value = peer.id;
      dom.messageInput.focus();
      renderPeers(rtc.connectedPeers);
    });
    dom.peerGrid.append(card);
  }
}

function renderRecipientOptions(peers = []) {
  const current = state.selectedPeer;
  dom.recipientSelect.textContent = "";
  dom.recipientSelect.append(new Option("Todos os dispositivos", "all"));
  for (const peer of peers.filter((item) => item.status !== "offline")) {
    dom.recipientSelect.append(new Option(peer.name, peer.id));
  }
  dom.recipientSelect.value = peers.some((peer) => peer.id === current) ? current : "all";
  state.selectedPeer = dom.recipientSelect.value;
}

function renderMessages() {
  dom.messageList.textContent = "";
  if (state.messages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "As mensagens recebidas e enviadas aparecerão aqui.";
    dom.messageList.append(empty);
    return;
  }
  for (const message of state.messages.slice(-120)) {
    const item = document.createElement("article");
    item.className = `message-item ${message.from === peerId ? "own" : ""} ${message.to !== "all" ? "private" : ""}`;
    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.innerHTML = `<span></span><time></time>`;
    meta.querySelector("span").textContent = `${message.from === peerId ? "Você" : peerName(message.from)} → ${message.to === "all" ? "todos" : peerName(message.to)}`;
    meta.querySelector("time").textContent = new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const text = document.createElement("div");
    text.className = "message-text";
    text.textContent = message.text;
    item.append(meta, text);
    dom.messageList.append(item);
  }
  dom.messageList.scrollTop = dom.messageList.scrollHeight;
}

async function createOffer() {
  setBusy(dom.createOfferButton, true);
  try {
    const signal = await rtc.createOffer();
    showSignal(signal, "Convite pronto", "No outro dispositivo, escaneie ou cole este SDP.");
    toast("Convite gerado.");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(dom.createOfferButton, false);
  }
}

async function processSignal() {
  setBusy(dom.processSignalButton, true);
  try {
    const answer = await rtc.processSignal(dom.signalTextarea.value);
    if (answer) {
      showSignal(answer, "Resposta pronta", "Envie esta resposta para quem criou o convite.");
      toast("Resposta gerada.");
    } else {
      toast("Pareamento aplicado.");
      dom.signalTextarea.value = "";
      hideQr();
    }
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(dom.processSignalButton, false);
  }
}

function showSignal(signal, title, hint) {
  const encoded = encodeSignal(signal);
  state.lastSignal = encoded;
  dom.signalTextarea.value = encoded;
  dom.qrImage.src = QRTools.makeImageUrl(encoded, 190);
  dom.qrTitle.textContent = title;
  dom.qrHint.textContent = hint;
  dom.qrBox.hidden = false;
}

function hideQr() {
  dom.qrBox.hidden = true;
  dom.qrImage.removeAttribute("src");
}

async function copySignal() {
  const value = dom.signalTextarea.value.trim();
  if (!value) {
    toast("Nada para copiar.");
    return;
  }
  await navigator.clipboard.writeText(value);
  toast("Copiado para a área de transferência.");
}

async function pasteSignal() {
  try {
    dom.signalTextarea.value = await navigator.clipboard.readText();
    toast("Texto colado.");
  } catch {
    toast("Permissão de clipboard negada.");
  }
}

async function startScan() {
  dom.cameraPanel.hidden = false;
  try {
    await qr.start();
    toast("Aponte a câmera para o QRCode.");
  } catch (error) {
    dom.cameraPanel.hidden = true;
    toast(error.message);
  }
}

function stopScan() {
  qr.stop();
  dom.cameraPanel.hidden = true;
}

async function sendMessage() {
  const text = dom.messageInput.value.trim();
  if (!text) return;
  const message = rtc.sendMessage(text, state.selectedPeer);
  await addMessage(message);
  dom.messageInput.value = "";
}

async function addMessage(message) {
  const stored = {
    id: `${message.timestamp}-${message.from}-${crypto.randomUUID()}`,
    ...message
  };
  state.messages.push(stored);
  state.messages = state.messages.slice(-160);
  await store.saveMessage(stored);
  renderMessages();
}

async function clearHistory() {
  await store.clear("messages");
  state.messages = [];
  renderMessages();
  toast("Histórico limpo.");
}

function openNameDialog() {
  dom.deviceNameInput.value = state.deviceName;
  dom.nameDialog.showModal();
  dom.deviceNameInput.focus();
  dom.deviceNameInput.select();
}

async function saveDeviceName(event) {
  event.preventDefault();
  const nextName = dom.deviceNameInput.value.trim().slice(0, 32) || makeDefaultName();
  state.deviceName = nextName;
  await store.setDeviceName(nextName);
  renderIdentity();
  rtc.broadcastPeerList();
  dom.nameDialog.close();
  toast("Nome atualizado.");
}

function updateNetworkStatus(peers) {
  const online = peers.filter((peer) => peer.status === "online").length;
  dom.networkStatus.querySelector("span:last-child").textContent = online === 0 ? "pronto para parear" : `${online} conectado${online > 1 ? "s" : ""}`;
}

function log(text) {
  const item = document.createElement("li");
  item.textContent = `${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${text}`;
  dom.connectionLog.prepend(item);
  while (dom.connectionLog.children.length > 8) {
    dom.connectionLog.lastElementChild.remove();
  }
}

function toast(text) {
  const item = document.createElement("div");
  item.className = "toast";
  item.textContent = text;
  dom.toastStack.append(item);
  window.setTimeout(() => item.remove(), 3600);
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.dataset.originalText ??= button.textContent;
  button.textContent = busy ? "Aguarde..." : button.dataset.originalText;
}

function statusLabel(peer) {
  if (peer.status === "online") return peer.direct ? "direto" : "online";
  if (peer.status === "stale") return "instável";
  if (peer.status === "known") return "descoberto";
  return "offline";
}

function peerName(id) {
  if (id === peerId) return "Você";
  return rtc.connectedPeers.find((peer) => peer.id === id)?.name || id.slice(0, 8);
}

function initials(name) {
  return String(name || "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function makeDefaultName() {
  const platform = navigator.userAgentData?.platform || navigator.platform || "Web";
  return `${platform} ${Math.floor(100 + Math.random() * 900)}`;
}

async function installPwa() {
  if (!state.deferredInstallPrompt) return;
  state.deferredInstallPrompt.prompt();
  await state.deferredInstallPrompt.userChoice;
  state.deferredInstallPrompt = null;
  dom.installCard.hidden = true;
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("./sw.js");
    log("Service worker registrado.");
  } catch (error) {
    log(`Service worker indisponível: ${error.message}`);
  }
}
