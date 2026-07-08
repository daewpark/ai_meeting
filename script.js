document.addEventListener('DOMContentLoaded', () => {
    const userAgent = navigator.userAgent;
    const isEdge = userAgent.includes("Edg");
    const isChrome = userAgent.includes("Chrome") && !isEdge;
    const isExtension = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;

    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const clearBtn = document.getElementById('clearBtn');
    const copyBtn = document.getElementById('copyBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const transcriptArea = document.getElementById('transcript');
    const statusBadge = document.getElementById('statusBadge');
    const statusText = document.getElementById('statusText');
    const keywordList = document.getElementById('keywordList');
    const langSelect = document.getElementById('langSelect'); // 언어 선택 가져오기

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

            recognition.start();
            isRecording = true;
            updateUIState(true);
        } catch (e) {
            console.error("마이크 권한 에러:", e);
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
        }
    });

    stopBtn.addEventListener('click', () => {
        isRecording = false; // 의도적 종료임을 명시
        recognition.stop();
        updateUIState(false);
        extractKeywords(finalTranscript); 
        
        if (finalTranscript.trim() !== '') {
            executeDownload();
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

    recognition.onerror = (event) => {
        if (event.error === 'not-allowed') {
            console.error("Speech API 차단됨");
            stopBtn.click();
        }
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