export const openDB = () => {
    return new Promise((resolve, reject) => {
        // Increment version to 2 to trigger upgrade for new schema
        const request = indexedDB.open('AstraeaDB', 2);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;

            // Projects store
            if (!db.objectStoreNames.contains('projects')) {
                db.createObjectStore('projects', { keyPath: 'id', autoIncrement: true });
            }

            // People store
            if (!db.objectStoreNames.contains('people')) {
                db.createObjectStore('people', { keyPath: 'id', autoIncrement: true });
            }

            // Sessions store (now includes recordings and transcripts)
            if (!db.objectStoreNames.contains('sessions')) {
                db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
            }

            // Keep transcriptions for legacy if needed, or migration could happen here
            if (!db.objectStoreNames.contains('transcriptions')) {
                db.createObjectStore('transcriptions', { keyPath: 'id' });
            }
        };

        // Fires when an older connection (e.g. another open tab) is holding the
        // DB open and blocking this version upgrade. Without this handler the
        // request just hangs forever with no success/error event, which looks
        // to the user like "nothing happens" when saving (e.g. registering a
        // new person) — reject explicitly instead so callers can surface it.
        request.onblocked = () => {
            reject(new Error('AstraeaDB upgrade blocked: close other open tabs of this app and try again.'));
        };

        request.onsuccess = (event) => {
            const db = event.target.result;
            // If another tab/process upgrades the schema later, this connection
            // becomes stale. Close it so it doesn't itself block that upgrade
            // (which would otherwise trigger the same silent-hang symptom there).
            db.onversionchange = () => db.close();
            resolve(db);
        };

        request.onerror = (event) => {
            reject(event.target.error);
        };
    });
};

// Generic CRUD helpers
export const saveData = async (storeName, data) => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.put(data);
        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = (event) => reject(event.target.error);
    });
};

export const getAllData = async (storeName) => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readonly');
        const store = transaction.objectStore(storeName);
        const request = store.getAll();
        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = (event) => reject(event.target.error);
    });
};

export const deleteData = async (storeName, id) => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.delete(id);
        request.onsuccess = () => resolve();
        request.onerror = (event) => reject(event.target.error);
    });
};

export const getDataById = async (storeName, id) => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readonly');
        const store = transaction.objectStore(storeName);
        const request = store.get(id);
        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = (event) => reject(event.target.error);
    });
};
