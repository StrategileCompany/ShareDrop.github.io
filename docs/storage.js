const DB_NAME = "meshdrop-db";
const DB_VERSION = 1;
const STORES = ["settings", "peers", "messages", "sessions"];

export class LocalStore {
  constructor() {
    this.dbPromise = this.open();
  }

  open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings");
        }
        if (!db.objectStoreNames.contains("peers")) {
          db.createObjectStore("peers", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("messages")) {
          const store = db.createObjectStore("messages", { keyPath: "id" });
          store.createIndex("timestamp", "timestamp");
        }
        if (!db.objectStoreNames.contains("sessions")) {
          db.createObjectStore("sessions", { keyPath: "id" });
        }
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  async transaction(storeName, mode, action) {
    if (!STORES.includes(storeName)) {
      throw new Error(`Store desconhecida: ${storeName}`);
    }
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const result = action(store);
      tx.oncomplete = () => resolve(result?.result ?? result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  getSetting(key) {
    return this.transaction("settings", "readonly", store => store.get(key));
  }

  setSetting(key, value) {
    return this.transaction("settings", "readwrite", store => store.put(value, key));
  }

  savePeer(peer) {
    return this.transaction("peers", "readwrite", store => store.put({ ...peer, savedAt: Date.now() }));
  }

  getRecentPeers() {
    return this.getAll("peers");
  }

  saveMessage(message) {
    return this.transaction("messages", "readwrite", store => store.put(message));
  }

  async getMessages(limit = 120) {
    const messages = await this.getAll("messages");
    return messages.sort((a, b) => a.timestamp - b.timestamp).slice(-limit);
  }

  clearMessages() {
    return this.transaction("messages", "readwrite", store => store.clear());
  }

  saveSession(session) {
    return this.transaction("sessions", "readwrite", store => store.put({ ...session, updatedAt: Date.now() }));
  }

  getSessions() {
    return this.getAll("sessions");
  }

  getAll(storeName) {
    return this.transaction(storeName, "readonly", store => store.getAll());
  }
}
