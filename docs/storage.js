const DB_NAME = "sharedrop-db";
const DB_VERSION = 1;

export class SharedropStore {
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
          const messages = db.createObjectStore("messages", { keyPath: "id" });
          messages.createIndex("timestamp", "timestamp");
        }
        if (!db.objectStoreNames.contains("sessions")) {
          db.createObjectStore("sessions", { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async get(storeName, key) {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const request = tx.objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async set(storeName, value, key) {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const request = key === undefined ? store.put(value) : store.put(value, key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async delete(storeName, key) {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const request = tx.objectStore(storeName).delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async clear(storeName) {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const request = tx.objectStore(storeName).clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async all(storeName, indexName) {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const source = indexName ? tx.objectStore(storeName).index(indexName) : tx.objectStore(storeName);
      const request = source.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  getDeviceName() {
    return this.get("settings", "deviceName");
  }

  setDeviceName(name) {
    return this.set("settings", name, "deviceName");
  }

  savePeer(peer) {
    return this.set("peers", { ...peer, lastSeen: Date.now() });
  }

  saveMessage(message) {
    return this.set("messages", message);
  }

  saveSession(session) {
    return this.set("sessions", session);
  }
}
