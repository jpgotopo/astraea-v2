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

// --- Full-database backup (export/import) ---
// Stores are exported in dependency order: projects and people first (so
// import can build an id-remap table for them), then sessions (which
// reference projectId/personId), then the legacy transcriptions store.
const BACKUP_STORES = ['projects', 'people', 'sessions', 'transcriptions'];
const BACKUP_FORMAT_VERSION = 1;

const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
});

// data: URLs round-trip cleanly through fetch() in every modern browser,
// which is the simplest way back to a Blob (with its original mime type)
// without hand-decoding base64.
const dataUrlToBlob = async (dataUrl) => (await fetch(dataUrl)).blob();

// Recursively walks a value, replacing any Blob with a JSON-serializable
// marker object (and back again on import). Session records are the only
// ones with Blobs today (`audio`, and `segments[].audioBlob`), but walking
// generically means this doesn't need to know that shape in detail.
const blobsOut = async (value) => {
    if (value instanceof Blob) {
        return { __blob: true, dataUrl: await blobToDataUrl(value) };
    }
    if (Array.isArray(value)) {
        return Promise.all(value.map(blobsOut));
    }
    if (value && typeof value === 'object') {
        const entries = await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await blobsOut(v)]));
        return Object.fromEntries(entries);
    }
    return value;
};

const blobsIn = async (value) => {
    if (value && typeof value === 'object' && value.__blob && typeof value.dataUrl === 'string') {
        return dataUrlToBlob(value.dataUrl);
    }
    if (Array.isArray(value)) {
        return Promise.all(value.map(blobsIn));
    }
    if (value && typeof value === 'object') {
        const entries = await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await blobsIn(v)]));
        return Object.fromEntries(entries);
    }
    return value;
};

// Bundles every store (projects, people, sessions with their audio, and the
// legacy transcriptions store) into one JSON-serializable object, suitable
// for `JSON.stringify`-ing to a downloadable file for backup / device-to-
// device migration.
export const exportBackup = async () => {
    const db = await openDB();
    const data = {};
    for (const storeName of BACKUP_STORES) {
        if (!db.objectStoreNames.contains(storeName)) continue;
        const records = await getAllData(storeName);
        data[storeName] = await Promise.all(records.map(blobsOut));
    }
    return {
        app: 'astraea',
        formatVersion: BACKUP_FORMAT_VERSION,
        exportedAt: new Date().toISOString(),
        data,
    };
};

// Restores a backup produced by exportBackup().
//
// mode 'replace' clears every store first, then writes the backup back with
// its original ids intact — for restoring a full backup onto a fresh/empty
// install.
//
// mode 'merge' (default) keeps whatever is already stored locally and adds
// the backup's records alongside it. Because IndexedDB autoIncrement ids are
// only unique per-device, reusing the backup's own ids here could silently
// overwrite unrelated local records that happen to share the same id — so
// merge mode strips incoming ids (letting the store assign fresh ones) and
// remaps sessions' projectId/personId to match, keeping cross-references
// intact without touching anything already on this device.
export const importBackup = async (payload, { mode = 'merge' } = {}) => {
    if (!payload || typeof payload !== 'object' || !payload.data || typeof payload.data !== 'object') {
        throw new Error('Invalid Astraea backup file');
    }
    if (payload.formatVersion !== BACKUP_FORMAT_VERSION) {
        throw new Error(`Unsupported backup format version: ${payload.formatVersion}`);
    }

    const db = await openDB();

    if (mode === 'replace') {
        for (const storeName of BACKUP_STORES) {
            if (!db.objectStoreNames.contains(storeName)) continue;
            await new Promise((resolve, reject) => {
                const tx = db.transaction(storeName, 'readwrite');
                tx.objectStore(storeName).clear();
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        }
    }

    // old id (stringified, since sessions store personId as a <select>'s
    // string value while people/projects ids are numbers) -> new id.
    const idMap = { projects: new Map(), people: new Map() };

    for (const storeName of ['projects', 'people']) {
        for (const raw of payload.data[storeName] || []) {
            const revived = await blobsIn(raw);
            if (mode === 'replace') {
                await saveData(storeName, revived);
                continue;
            }
            const { id: oldId, ...rest } = revived;
            const newId = await saveData(storeName, rest);
            if (oldId !== undefined) idMap[storeName].set(String(oldId), newId);
        }
    }

    for (const raw of payload.data.sessions || []) {
        const revived = await blobsIn(raw);
        if (mode === 'replace') {
            await saveData('sessions', revived);
            continue;
        }
        const { id: _oldId, ...rest } = revived;
        if (rest.projectId !== undefined && idMap.projects.has(String(rest.projectId))) {
            rest.projectId = idMap.projects.get(String(rest.projectId));
        }
        if (rest.personId !== undefined && idMap.people.has(String(rest.personId))) {
            rest.personId = idMap.people.get(String(rest.personId));
        }
        await saveData('sessions', rest);
    }

    if (db.objectStoreNames.contains('transcriptions')) {
        for (const raw of payload.data.transcriptions || []) {
            const revived = await blobsIn(raw);
            if (mode === 'replace') {
                await saveData('transcriptions', revived);
            } else {
                const { id: _oldId, ...rest } = revived;
                await saveData('transcriptions', rest);
            }
        }
    }
};
