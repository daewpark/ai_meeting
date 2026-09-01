// ===== 서비스 워커 등록 (PWA) =====
// 페이지가 로드되면 바로 등록합니다. DOMContentLoaded를 기다릴 필요는 없습니다.
// 이 서비스 워커는 정적 파일을 캐싱하지 않고, Background Sync(백그라운드 저장) 역할만 합니다.
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch((e) => {
        console.error('서비스 워커 등록 실패:', e);
    });
}

document.addEventListener('DOMContentLoaded', () => {
    // ===== AI 요약 → Notion 저장 설정 (Vercel 단일 배포 버전) =====
    // 이 사이트와 /api/summarize가 같은 Vercel 프로젝트에서 함께 배포되므로,
    // 별도 서버 주소 없이 상대경로만으로 호출합니다. 보통 이 값을 바꿀 필요는 없습니다.
    const NOTION_WORKER_URL = '/api/summarize';

    // (선택) Vercel 환경변수에 CLIENT_SECRET을 설정했다면, 여기에도 같은 값을 넣어주세요.
    // 완전한 보안은 아니지만(클라이언트 코드는 누구나 볼 수 있음) 무단 호출을 줄여줍니다.
    // 설정하지 않았다면 빈 문자열로 두세요.
    const NOTION_CLIENT_SECRET = '';

    // ===== 백그라운드 저장(Background Sync) 지원 여부 =====
    // Chrome/Edge 등 크로미움 계열 브라우저는 서비스 워커의 Background Sync를 지원합니다.
    // 이 기능이 있으면 "녹음 중지" 이후 다른 창/앱으로 전환해도 브라우저가 백그라운드에서
    // 요약/저장 요청을 대신 처리해줍니다. 지원하지 않는 브라우저(Firefox, Safari 등)는
    // 예전과 동일하게 이 화면에 머문 채로 직접 전송하는 방식(fallback)으로 자동 전환됩니다.
    const supportsBackgroundSync = 'serviceWorker' in navigator && 'SyncManager' in window;

    const SYNC_DB_NAME = 'meeting-minute-sync';
    const SYNC_STORE_NAME = 'pending';
    const SYNC_TAG = 'save-notion';

    function openSyncDb() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(SYNC_DB_NAME, 1);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(SYNC_STORE_NAME)) {
                    req.result.createObjectStore(SYNC_STORE_NAME, { autoIncrement: true });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    // 저장할 회의록을 IndexedDB에 넣어둡니다. 실제 전송은 서비스 워커가 백그라운드에서 담당합니다.
    // 나중에 타임아웃으로 포기하고 지워야 할 수도 있어서, 생성된 키를 돌려줍니다.
    async function addPendingSave(record) {
        const db = await openSyncDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(SYNC_STORE_NAME, 'readwrite');
            const req = tx.objectStore(SYNC_STORE_NAME).add(record);
            tx.oncomplete = () => resolve(req.result);
            tx.onerror = () => reject(tx.error);
        });
    }

    // 대기 항목을 지웁니다. 백그라운드 저장이 시간 내 시작되지 않아 직접 전송으로
    // 전환할 때, 나중에 sync가 뒤늦게 실행되면서 같은 내용을 중복 저장하지 않도록 정리합니다.
    async function deletePendingSave(key) {
        const db = await openSyncDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(SYNC_STORE_NAME, 'readwrite');
            tx.objectStore(SYNC_STORE_NAME).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    const userAgent = navigator.userAgent;
    const isEdge = userAgent.includes("Edg");
    const isChrome = userAgent.includes("Chrome") && !isEdge;
    const isExtension = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;

    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const clearBtn = document.getElementById('clearBtn');
    const copyBtn = document.getElementById('copyBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const notionBtn = document.getElementById('notionBtn');
    const transcriptArea = document.getElementById('transcript');
    const statusBadge = document.getElementById('statusBadge');
    const statusText = document.getElementById('statusText');
    const keywordList = document.getElementById('keywordList');
    const langSelect = document.getElementById('langSelect'); // 언어 선택 가져오기

    const NOTION_BTN_DEFAULT_TEXT = notionBtn.innerText; // 'AI 요약 → Notion'

    // 서비스 워커가 백그라운드에서 저장을 끝낸 뒤 보내주는 완료/실패 메시지를 받아
    // 화면(버튼 문구, 안내 텍스트)을 갱신합니다. 이 화면이 열려있을 때만 반영되며,
    // 백그라운드 저장 자체는 이 화면이 닫혀있어도 이미 끝난 상태이므로 문제없습니다.
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (event) => {
            const msg = event.data || {};
            if (msg.type === 'notion-save-success') {
                notionBtn.innerText = '저장 완료!';
                transcriptArea.value = `※ (백그라운드) Notion에 저장되었습니다${msg.title ? ` (제목: ${msg.title})` : ''}.${msg.url ? `\n${msg.url}` : ''}\n\n` + transcriptArea.value;
                setTimeout(() => {
                    notionBtn.innerText = NOTION_BTN_DEFAULT_TEXT;
                    notionBtn.disabled = false;
                }, 2500);
            } else if (msg.type === 'notion-save-failed') {
                notionBtn.innerText = '저장 실패';
                transcriptArea.value = `※ (백그라운드) AI 요약/Notion 저장에 실패했습니다.\n${msg.message || ''}\n다시 시도해주세요.\n\n` + transcriptArea.value;
                setTimeout(() => {
                    notionBtn.innerText = NOTION_BTN_DEFAULT_TEXT;
                    notionBtn.disabled = false;
                }, 2500);
            }
        });
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    let recognition;
    let finalTranscript = '';
    let isRecording = false;

    if (!SpeechRecognition) {
        transcriptArea.value = "이 브라우저에서는 음성 인식을 지원하지 않습니다.";
        startBtn.disabled = true;
        return;
    }

    recognition = new SpeechRecognition();
    recognition.continuous = true; 
    recognition.interimResults = true; 
    recognition.lang = langSelect.value; // 초기 언어 설정 적용

    // 사용자가 드롭다운에서 언어를 변경했을 때의 동작
    langSelect.addEventListener('change', () => {
        recognition.lang = langSelect.value;
        // 만약 녹음 중에 언어를 바꿨다면, 즉시 껐다 켜서 새 언어 적용
        if (isRecording) {
            recognition.stop(); 
            // stop()이 호출되면 onend 이벤트가 발생하여 자동으로 새 언어로 다시 시작됩니다.
        }
    });

    startBtn.addEventListener('click', async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(track => track.stop());

            isRecording = true;
            recognition.start();
            // "녹음 중" UI 전환은 실제로 인식이 시작된 뒤(recognition.onstart)에 처리합니다.
        } catch (e) {
            console.error("녹음 시작 에러:", e);
            isRecording = false;
            updateUIState(false);

            // getUserMedia가 거부된 경우에만 마이크 "권한" 문제입니다.
            // recognition.start()에서 던진 다른 종류의 에러(예: InvalidStateError)를
            // 권한 문제로 오인해 안내하지 않도록 구분합니다.
            const isPermissionError = e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError';

            if (isPermissionError) {
                if (isExtension) {
                    if (isChrome) {
                        transcriptArea.value = '※ 마이크 접근 권한이 필요합니다.\n새 탭이 열리면 화면 좌측 상단(주소창 옆)에서 마이크 권한을 [허용]해 주신 뒤 탭을 닫아주세요!\n이후 사이드바에서 다시 [녹음 시작]을 누르면 정상 작동합니다.\n\n' + transcriptArea.value;
                    } else if (isEdge) {
                        transcriptArea.value = '※ [Edge 확장프로그램] 마이크 접근 권한이 필요합니다.\n새 탭이 열리면 마이크 권한을 [허용]으로 변경해주세요.\n\n' + transcriptArea.value;
                    }
                    if (chrome.tabs) chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
                } else {
                    if (isEdge) {
                        transcriptArea.value = '※ [Edge 브라우저] 마이크 권한이 차단되었습니다.\n화면 우측 상단 주소창 옆의 [자물쇠] 또는 [설정] 아이콘을 눌러 마이크 권한을 [허용]해주세요.\n\n' + transcriptArea.value;
                    } else if (isChrome) {
                        transcriptArea.value = '※ [Chrome 브라우저] 마이크 권한이 차단되었습니다.\n주소창 좌측 상단의 [설정(아이콘)]을 클릭해 마이크 권한을 켜주세요.\n\n' + transcriptArea.value;
                    } else {
                        transcriptArea.value = '※ 마이크 권한이 필요합니다. 브라우저 설정에서 권한을 허용해주세요.\n\n' + transcriptArea.value;
                    }
                }
            } else {
                // 권한은 정상인데 다른 이유(예: 인식기 상태 오류)로 시작 자체가 실패한 경우
                transcriptArea.value = `※ 녹음을 시작하지 못했습니다. (${e.name || 'Error'}${e.message ? ': ' + e.message : ''})\n마이크 권한은 정상이지만 다른 문제로 시작이 실패했습니다. 잠시 후 다시 시도해주세요.\n\n` + transcriptArea.value;
            }
        }
    });

    stopBtn.addEventListener('click', () => {
        isRecording = false; // 의도적 종료임을 명시
        recognition.stop();
        updateUIState(false);
        extractKeywords(finalTranscript);

        if (finalTranscript.trim() !== '') {
            // 녹음 중지와 동시에 AI 요약 → Notion 저장까지 자동으로 진행합니다.
            // (원문은 Notion에 .txt 첨부파일로 저장되므로, 컴퓨터로의 별도 자동 다운로드는 하지 않습니다.
            //  필요하면 "저장" 버튼으로 언제든 수동으로 로컬에 다운로드할 수 있습니다.)
            // (silent: true → 내용이 비어있을 때 알림창을 띄우지 않고 조용히 건너뜁니다.
            //  'not-allowed' 에러 처리 등에서 프로그램적으로 stopBtn.click()이 호출될 때를 대비한 안전장치입니다.)
            saveToNotion({ silent: true });
        }
    });

    recognition.onresult = (event) => {
        let interimTranscript = '';
        
        for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
                finalTranscript += event.results[i][0].transcript.trim() + '\n';
            } else {
                interimTranscript += event.results[i][0].transcript;
            }
        }
        
        transcriptArea.value = finalTranscript + interimTranscript;
        transcriptArea.scrollTop = transcriptArea.scrollHeight; 
        
        if (finalTranscript.length > 30) extractKeywords(finalTranscript);
    };

    recognition.onstart = () => {
        // 인식 엔진이 실제로 시작을 확인해준 시점에만 "녹음 중" UI로 전환합니다.
        updateUIState(true);
    };

    recognition.onerror = (event) => {
        console.error("Speech API 에러:", event.error);

        if (event.error === 'not-allowed') {
            console.error("Speech API 차단됨");
            stopBtn.click();
            return;
        }

        if (event.error === 'network' || event.error === 'service-not-allowed') {
            // Edge에서 마이크 권한은 정상인데도 음성인식 서버 연결이 막혀 발생하는 경우가 많습니다
            // (사내망/프록시 환경, 또는 브라우저 자체 버그). 지금까지는 이 에러를 무시해서
            // 화면은 "녹음 중"으로 보이지만 실제로는 아무것도 인식되지 않는 문제가 있었습니다.
            isRecording = false;
            updateUIState(false);
            transcriptArea.value = `※ 음성인식 서버에 연결하지 못했습니다. (${event.error})\n마이크 권한은 정상이지만, 네트워크(사내망/프록시 등) 또는 브라우저 문제로 음성인식이 실패했을 수 있습니다.\n다른 네트워크에서 다시 시도하거나 잠시 후 다시 시도해주세요.\n\n` + transcriptArea.value;
            return;
        }

        if (event.error === 'audio-capture') {
            isRecording = false;
            updateUIState(false);
            transcriptArea.value = '※ 마이크 장치를 찾을 수 없습니다. 마이크가 연결되어 있는지, 다른 프로그램이 마이크를 사용 중인지 확인해주세요.\n\n' + transcriptArea.value;
            return;
        }

        if (event.error === 'no-speech') {
            // 무음이 감지된 것뿐이므로 계속 듣기 상태를 유지합니다 (onend에서 자동 재시작).
            return;
        }

        // 그 외 알 수 없는 에러
        isRecording = false;
        updateUIState(false);
        transcriptArea.value = `※ 알 수 없는 오류로 녹음이 중단되었습니다. (${event.error})\n\n` + transcriptArea.value;
    };

    recognition.onend = () => {
        if (isRecording) {
            // 녹음 중(isRecording=true)인데 끊겼다면 자동 재시작 (언어 변경 시에도 이 로직이 활용됨)
            setTimeout(() => {
                try { recognition.start(); } catch(e) {}
            }, 100);
        } else {
            // 사용자가 중지 버튼을 눌러서 끊긴 경우 UI 업데이트
            updateUIState(false);
        }
    };

    function updateUIState(recording) {
        if (recording) {
            startBtn.classList.add('hidden');
            stopBtn.classList.remove('hidden');
            statusBadge.classList.add('recording');
            statusText.innerText = '녹음 중';
            langSelect.disabled = false; // 녹음 중에도 언어 변경 가능하도록 유지
        } else {
            startBtn.classList.remove('hidden');
            stopBtn.classList.add('hidden');
            statusBadge.classList.remove('recording');
            statusText.innerText = '대기 중';
        }
    }

    clearBtn.addEventListener('click', () => {
        finalTranscript = '';
        transcriptArea.value = '';
        keywordList.innerHTML = '<span class="empty-text">자주 언급된 단어가 여기에 나타납니다.</span>';
    });

    copyBtn.addEventListener('click', () => {
        transcriptArea.select();
        document.execCommand('copy'); 
        copyBtn.innerText = '완료';
        setTimeout(() => { copyBtn.innerText = '복사'; }, 2000);
    });

    downloadBtn.addEventListener('click', () => {
        if (!finalTranscript.trim()) return;
        executeDownload();
    });

    notionBtn.addEventListener('click', () => saveToNotion({ silent: false }));

    // 백그라운드 저장이 "시작됐다"는 신호(또는 이미 끝난 성공/실패 신호)를 이 시간(ms) 안에
    // 받지 못하면, Background Sync가 실제로는 동작하지 않는 환경(예: 브라우저/기업 정책으로
    // 막혀있는 경우)이라고 판단하고 직접 전송 방식으로 전환합니다.
    // (실제 요약 작업 자체가 오래 걸리는 것은 이 타임아웃과 무관합니다 — 서비스 워커가
    //  작업을 "시작"만 알려주면 충분하고, 이후 완료까지는 기다리는 시간에 제한을 두지 않습니다.)
    const BACKGROUND_SYNC_START_TIMEOUT_MS = 10000;

    // 서비스 워커가 보내는 'notion-save-started' / 'notion-save-success' / 'notion-save-failed'
    // 메시지 중 하나가 timeoutMs 안에 도착하면 true, 안 오면 false를 반환합니다.
    function waitForBackgroundStart(timeoutMs) {
        return new Promise((resolve) => {
            let done = false;
            const onMessage = (event) => {
                const type = (event.data || {}).type;
                if (type === 'notion-save-started' || type === 'notion-save-success' || type === 'notion-save-failed') {
                    finish(true);
                }
            };
            const finish = (result) => {
                if (done) return;
                done = true;
                navigator.serviceWorker.removeEventListener('message', onMessage);
                clearTimeout(timer);
                resolve(result);
            };
            navigator.serviceWorker.addEventListener('message', onMessage);
            const timer = setTimeout(() => finish(false), timeoutMs);
        });
    }

    // AI 요약 → Notion 저장을 시작하는 진입점.
    // "AI 요약 → Notion" 버튼을 직접 눌렀을 때(silent: false)와, 녹음 중지 시 자동으로
    // 호출될 때(silent: true) 양쪽에서 공통으로 사용합니다.
    //
    // Background Sync를 지원하는 브라우저(Edge/Chrome)에서는 서비스 워커에게 저장을 맡겨서
    // 이 화면을 벗어나도 백그라운드에서 계속 처리되게 하고, 지원하지 않는 브라우저나
    // Background Sync가 실제로 동작하지 않는 환경에서는 예전과 동일하게 이 화면에서
    // 직접 전송합니다(90초 타임아웃 포함, fallback).
    async function saveToNotion({ silent } = {}) {
        if (!finalTranscript.trim()) {
            if (!silent) alert('저장할 회의 내용이 없습니다. 먼저 녹음을 진행해주세요.');
            return;
        }
        // 이미 저장이 진행 중이면(예: 자동 저장 도중 버튼을 또 누른 경우) 중복 호출을 막습니다.
        if (notionBtn.disabled) return;

        if (supportsBackgroundSync) {
            let pendingKey = null;
            try {
                notionBtn.disabled = true;
                notionBtn.innerText = '요약 중... (백그라운드)';

                pendingKey = await queueBackgroundSave(finalTranscript);

                const started = await waitForBackgroundStart(BACKGROUND_SYNC_START_TIMEOUT_MS);
                if (started) return; // 이후 완료/실패는 위에서 등록한 전역 'message' 리스너가 화면에 반영합니다.

                console.warn('백그라운드 저장이 시간 내에 시작되지 않았습니다(Background Sync 미동작 추정). 직접 전송으로 전환합니다.');
                await deletePendingSave(pendingKey).catch(() => {});
            } catch (e) {
                // IndexedDB 저장이나 sync 등록 자체가 실패한 경우입니다.
                console.error('백그라운드 저장 등록 실패, 직접 전송으로 대체합니다:', e);
                if (pendingKey !== null) await deletePendingSave(pendingKey).catch(() => {});
            }
        }

        await saveToNotionDirect(finalTranscript);
    }

    // 회의록을 IndexedDB에 넣어두고 Background Sync를 등록합니다. 생성된 키를 돌려줘서,
    // 나중에 타임아웃으로 포기해야 할 경우 이 항목을 지울 수 있게 합니다.
    // 실제 전송은 서비스 워커(service-worker.js)가 담당하며, 완료/실패 결과는
    // 위에서 등록한 'message' 리스너를 통해 비동기로 이 화면에 반영됩니다.
    async function queueBackgroundSave(transcript) {
        const registration = await navigator.serviceWorker.ready;
        const key = await addPendingSave({
            url: NOTION_WORKER_URL,
            clientSecret: NOTION_CLIENT_SECRET,
            transcript,
        });
        await registration.sync.register(SYNC_TAG);
        return key;
    }

    // 화면에 머문 채로 직접 fetch로 전송하는 기존 방식.
    // Background Sync 미지원 브라우저(Firefox, Safari 등)와, 위 큐 등록이 실패했을 때의
    // fallback으로 사용됩니다.
    async function saveToNotionDirect(transcript) {
        notionBtn.disabled = true;
        notionBtn.innerText = '요약 중...';

        // 요청이 응답 없이 무한정 멈춰있는 것을 막기 위한 타임아웃(90초).
        // 화면이 백그라운드로 밀려나면 브라우저가 네트워크 요청을 일시정지시켜서
        // 아무 성공/실패 메시지도 없이 그냥 멈춰버리는 경우가 있어, 최소한 이 시간이 지나면
        // 확실한 실패 메시지를 보여주도록 합니다.
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 90000);

        try {
            const headers = { 'Content-Type': 'application/json' };
            if (NOTION_CLIENT_SECRET) headers['X-Client-Secret'] = NOTION_CLIENT_SECRET;

            const res = await fetch(NOTION_WORKER_URL, {
                method: 'POST',
                headers,
                body: JSON.stringify({ transcript }),
                signal: controller.signal,
            });

            let data;
            try {
                data = await res.json();
            } catch (parseErr) {
                data = {};
            }

            if (!res.ok || data.error) {
                // data.detail에는 Notion/Claude API가 실제로 돌려준 원인이 들어있어서,
                // 화면에 함께 보여줘야 어디가 문제인지 바로 알 수 있습니다.
                const detailText = data.detail ? ` — ${typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)}` : '';
                throw new Error((data.error || `서버 오류 (${res.status})`) + detailText);
            }

            notionBtn.innerText = '저장 완료!';
            transcriptArea.value = `※ Notion에 저장되었습니다${data.title ? ` (제목: ${data.title})` : ''}.${data.url ? `\n${data.url}` : ''}\n\n` + transcriptArea.value;
        } catch (e) {
            console.error('Notion 저장 에러:', e);
            notionBtn.innerText = '저장 실패';
            const isTimeout = e.name === 'AbortError';
            const message = isTimeout
                ? '90초 넘게 응답이 없어 요청을 취소했습니다. 요약이 진행되는 동안에는 이 화면을 다른 창으로 전환하지 마시고, 다시 시도해주세요.'
                : e.message;
            transcriptArea.value = `※ AI 요약/Notion 저장에 실패했습니다.\n${message}\n\n` + transcriptArea.value;
        } finally {
            clearTimeout(timeoutId);
            setTimeout(() => {
                notionBtn.innerText = NOTION_BTN_DEFAULT_TEXT;
                notionBtn.disabled = false;
            }, 2500);
        }
    }

    function executeDownload() {
        const blob = new Blob([transcriptArea.value], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        
        const date = new Date();
        const yyyy = date.getFullYear();
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const dd = String(date.getDate()).padStart(2, '0');
        const hh = String(date.getHours()).padStart(2, '0');
        const min = String(date.getMinutes()).padStart(2, '0');
        
        a.href = url;
        a.download = `회의록_${yyyy}${mm}${dd}_${hh}${min}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    }

    function extractKeywords(text) {
        if (!text || text.trim() === '') return;
        
        const words = text.replace(/[.,!?을를이가은는에서으로로의와과]/g, ' ')
                         .split(/\s+/)
                         .filter(w => w.length > 1);
        
        const frequency = {};
        words.forEach(word => frequency[word] = (frequency[word] || 0) + 1);
        
        const sortedKeywords = Object.entries(frequency)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6);

        if (sortedKeywords.length > 0) {
            keywordList.innerHTML = sortedKeywords.map(([word, count]) => {
                return `<span class="keyword">${word} (${count})</span>`;
            }).join('');
        }
    }
});