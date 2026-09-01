// ===== 회의록 서비스 워커 =====
//
// 이 파일은 두 가지만 합니다.
//   1) 이 앱을 "설치 가능한 앱(PWA)"으로 인식되게 해줍니다. (manifest.json과 함께)
//   2) Background Sync를 이용해, "녹음 중지" 이후의 AI 요약 → Notion 저장 요청을
//      이 페이지가 백그라운드(다른 창/탭으로 전환된 상태)에 있어도 대신 처리해줍니다.
//
// 일부러 index.html/script.js 같은 정적 파일은 캐싱하지 않습니다.
// (캐싱을 하면 재배포 후에도 사용자가 예전 버전을 계속 보게 되는 문제가 생길 수 있어,
//  이 앱처럼 자주 수정되는 개인용 도구에는 캐싱의 이득보다 위험이 더 크다고 판단했습니다.)
// 그래서 이 파일에는 'fetch' 이벤트 핸들러가 없습니다 — 일반적인 페이지 로드/네트워크
// 요청은 전부 브라우저 기본 동작 그대로 흘러갑니다.

const DB_NAME = 'meeting-minute-sync';
const STORE_NAME = 'pending';
const SYNC_TAG = 'save-notion';

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(STORE_NAME)) {
                req.result.createObjectStore(STORE_NAME, { autoIncrement: true });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// 저장 대기 중인 항목을 전부 가져옵니다. (script.js에서 IndexedDB에 넣어둔 회의록들)
async function getAllPending() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const keysReq = store.getAllKeys();
        const valuesReq = store.getAll();
        let keys, values;
        const tryResolve = () => {
            if (keys !== undefined && values !== undefined) {
                resolve(keys.map((key, i) => ({ key, record: values[i] })));
            }
        };
        keysReq.onsuccess = () => { keys = keysReq.result; tryResolve(); };
        valuesReq.onsuccess = () => { values = valuesReq.result; tryResolve(); };
        tx.onerror = () => reject(tx.error);
    });
}

async function deletePending(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// 현재 열려있는 페이지(들)에 완료/실패 결과를 알려서 화면(버튼 문구 등)을 갱신하게 합니다.
// 페이지가 닫혀있으면 그냥 아무 효과 없이 지나갑니다 (저장 자체는 이미 끝난 상태이므로 문제 없음).
async function notifyClients(message) {
    const clientsList = await self.clients.matchAll({ type: 'window' });
    clientsList.forEach((client) => client.postMessage(message));
}

self.addEventListener('install', () => {
    // 새 버전의 서비스 워커가 곧바로 활성화되도록 합니다 (구버전이 남아 헷갈리는 것을 방지).
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('sync', (event) => {
    if (event.tag === SYNC_TAG) {
        event.waitUntil(handlePendingSaves());
    }
});

async function handlePendingSaves() {
    const items = await getAllPending();
    let hadFailure = false;

    for (const { key, record } of items) {
        // 실제 전송을 시작하기 직전에 페이지 쪽에 알려줍니다. script.js는 이 신호(또는 아래의
        // 성공/실패 신호)를 정해진 시간 안에 받지 못하면 "Background Sync가 아예 동작하지
        // 않는다"고 판단해 직접 전송 방식으로 전환하므로, 이 신호를 최대한 먼저 보내야 합니다.
        await notifyClients({ type: 'notion-save-started' });
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (record.clientSecret) headers['X-Client-Secret'] = record.clientSecret;

            const res = await fetch(record.url, {
                method: 'POST',
                headers,
                body: JSON.stringify({ transcript: record.transcript }),
            });

            let data = {};
            try {
                data = await res.json();
            } catch (parseErr) {
                data = {};
            }

            if (!res.ok || data.error) {
                const detailText = data.detail
                    ? ` — ${typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)}`
                    : '';
                throw new Error((data.error || `서버 오류 (${res.status})`) + detailText);
            }

            await deletePending(key);
            await notifyClients({ type: 'notion-save-success', title: data.title, url: data.url });
        } catch (e) {
            hadFailure = true;
            console.error('[service-worker] Notion 저장 실패:', e);
            await notifyClients({ type: 'notion-save-failed', message: e.message });
            // 이 항목은 지우지 않고 그대로 둡니다. 아래에서 sync 이벤트를 실패로 끝내면
            // 브라우저가 알아서 재시도를 예약해줍니다.
        }
    }

    if (hadFailure) {
        throw new Error('일부 저장 작업이 실패하여 재시도가 예약되었습니다.');
    }
}
