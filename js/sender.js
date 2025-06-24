// 送信側アプリケーションのロジック

let qrFrames = [];
let currentFrameIndex = 0;
let transmissionInterval = null;
let isTransmitting = false;
let isPaused = false;

// DOM要素の取得
const inputText = document.getElementById('inputText');
const charCount = document.getElementById('charCount');
const byteCount = document.getElementById('byteCount');
const intervalSlider = document.getElementById('intervalSlider');
const intervalValue = document.getElementById('intervalValue');
const startButton = document.getElementById('startButton');
const newTransmissionButton = document.getElementById('newTransmissionButton');
const qrDisplay = document.getElementById('qrDisplay');
const frameInfo = document.getElementById('frameInfo');
const currentFrame = document.getElementById('currentFrame');
const totalFrames = document.getElementById('totalFrames');
const frameNumber = document.getElementById('frameNumber');
const manualControls = document.getElementById('manualControls');
const pauseButton = document.getElementById('pauseButton');
const startTransmissionSection = document.getElementById('startTransmissionSection');
const startLoopButton = document.getElementById('startLoopButton');
const secondaryControls = document.getElementById('secondaryControls');
const transmissionCompleteSection = document.getElementById('transmissionCompleteSection');
const startButtonContainer = document.getElementById('startButtonContainer');
const controlSection = document.getElementById('controlSection');

// イベントリスナーの設定
inputText.addEventListener('input', updateTextInfo);
intervalSlider.addEventListener('input', updateIntervalDisplay);

// キーボードショートカット
document.addEventListener('keydown', (e) => {
    if (!isTransmitting) return;
    
    switch(e.key) {
        case 'ArrowLeft':
            e.preventDefault();
            previousFrame();
            break;
        case 'ArrowRight':
            e.preventDefault();
            nextFrame();
            break;
        case ' ':
            e.preventDefault();
            togglePause();
            break;
    }
});

// テキスト情報の更新
function updateTextInfo() {
    const text = inputText.value;
    charCount.textContent = text.length;
    byteCount.textContent = Utils.getByteLength(text);
}

// 表示間隔の更新
function updateIntervalDisplay() {
    intervalValue.textContent = intervalSlider.value;
    
    // 送信中の場合はリアルタイムで間隔を更新
    if (isTransmitting && transmissionInterval) {
        clearInterval(transmissionInterval);
        const newInterval = parseInt(intervalSlider.value);
        transmissionInterval = setInterval(displayNextFrame, newInterval);
    }
}

// 送信開始（ヘッダーQRのみ表示）
async function startTransmission() {
    const text = inputText.value.trim();
    
    if (!text) {
        alert('送信するテキストを入力してください');
        return;
    }
    
    // QRコードフレームの生成
    try {
        qrFrames = await generateQRFrames(text);
        currentFrameIndex = 0;
        
        // UI更新（ヘッダーQRと送信開始ボタンを表示）
        startButtonContainer.style.display = 'none';
        startTransmissionSection.style.display = 'block';
        newTransmissionButton.style.display = 'inline-block';
        
        // ヘッダーQRコードのみ表示
        displayHeaderOnly();
        
    } catch (error) {
        console.error('QRコード生成エラー:', error);
        alert('QRコードの生成に失敗しました: ' + error.message);
    }
}

// ヘッダーQRのみ表示
function displayHeaderOnly() {
    if (!qrFrames || qrFrames.length === 0) return;
    
    const headerFrame = qrFrames[0];
    
    // フレーム番号を非表示
    frameNumber.style.display = 'none';
    
    // QRコード表示
    qrDisplay.innerHTML = '';
    
    if (typeof QRCode === 'undefined') {
        console.error('QRCodeライブラリが読み込まれていません');
        return;
    }
    
    const qrContainer = document.createElement('div');
    qrDisplay.appendChild(qrContainer);
    
    const qrcode = new QRCode(qrContainer, {
        text: headerFrame.data,
        width: 300,
        height: 300,
        correctLevel: QRCode.CorrectLevel.L
    });
}

// データ送信開始（ループ表示）
function startLoop() {
    if (!qrFrames || qrFrames.length === 0) return;
    
    isTransmitting = true;
    currentFrameIndex = 0;
    
    // UI更新
    controlSection.style.display = 'none'; // 空のコントロールセクションを非表示
    frameInfo.style.display = 'block';
    frameNumber.style.display = 'block';
    manualControls.style.display = 'flex';
    secondaryControls.style.display = 'block';
    transmissionCompleteSection.style.display = 'none';
    totalFrames.textContent = qrFrames.length - 1; // ヘッダーを除外
    
    // ヘッダーをスキップして最初のデータフレームから開始
    currentFrameIndex = 1;
    displayCurrentFrame();
    
    // インターバル設定
    const interval = parseInt(intervalSlider.value);
    transmissionInterval = setInterval(displayNextFrame, interval);
}

// 送信停止（Wake Lock解放用）
function stopTransmission() {
    isTransmitting = false;
    
    if (transmissionInterval) {
        clearInterval(transmissionInterval);
        transmissionInterval = null;
    }
}

// 新規送信
function newTransmission() {
    // 送信中の場合は停止
    if (isTransmitting) {
        isTransmitting = false;
        
        if (transmissionInterval) {
            clearInterval(transmissionInterval);
            transmissionInterval = null;
        }
    }
    
    // UI更新
    controlSection.style.display = 'block';
    startButtonContainer.style.display = 'block';
    startTransmissionSection.style.display = 'none';
    newTransmissionButton.style.display = 'none';
    frameInfo.style.display = 'none';
    frameNumber.style.display = 'none';
    manualControls.style.display = 'none';
    secondaryControls.style.display = 'none';
    transmissionCompleteSection.style.display = 'none';
    qrDisplay.innerHTML = '<p>QRコードがここに表示されます</p>';
    isPaused = false;
    pauseButton.innerHTML = '⏸ 一時停止';
    
    // テキストエリアをクリアしてフォーカス
    inputText.value = '';
    inputText.focus();
    
    // テキスト情報を更新
    updateTextInfo();
}

// QRコードフレームの生成
async function generateQRFrames(text) {
    const frames = [];
    
    // データのハッシュ計算
    const dataHash = Utils.calculateHash(text);
    const dataSize = Utils.getByteLength(text);
    
    // データ分割（QRコード容量を考慮）
    // プロトコルオーバーヘッド: "DAT|seq:X|data:|crc:12345678|b64:1" = 約40バイト
    // Base64エンコード後は元の1.33倍のサイズになる
    // QRコード（エラー訂正レベルL）は約2900バイトまで格納可能
    const maxDataSize = 600; // QRコードに含められる実データサイズ（Base64エンコード前）
    const chunks = Utils.splitData(text, maxDataSize);
    
    // ヘッダーQRコード生成
    // 総フレーム数 = ヘッダー(1) + データフレーム(chunks.length) = chunks.length + 1
    const totalFrameCount = chunks.length + 1;
    const headerData = QRFormat.createHeader(totalFrameCount, dataSize, dataHash);
    frames.push({
        type: 'header',
        data: headerData
    });
    
    // データQRコード生成
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const crc = Utils.calculateCRC(chunk);
        const dataQR = QRFormat.createData(i + 1, chunk, crc);
        
        frames.push({
            type: 'data',
            sequence: i + 1,
            data: dataQR
        });
    }
    
    return frames;
}

// 現在のフレームを表示（インデックスを変更しない）
function displayCurrentFrame() {
    if (!isTransmitting || qrFrames.length === 0) {
        return;
    }
    
    const frame = qrFrames[currentFrameIndex];
    
    // フレーム情報更新（ヘッダーを除外して表示）
    if (frame.type === 'header') {
        currentFrame.textContent = 'H';
        frameNumber.textContent = 'H';
    } else {
        currentFrame.textContent = frame.sequence;
        frameNumber.textContent = frame.sequence + ' / ' + (qrFrames.length - 1);
    }
    
    // QRコード生成と表示
    qrDisplay.innerHTML = '';
    
    if (typeof QRCode === 'undefined') {
        console.error('QRCodeライブラリが読み込まれていません');
        alert('QRCodeライブラリの読み込みエラー');
        return;
    }
    
    const qrContainer = document.createElement('div');
    qrDisplay.appendChild(qrContainer);
    
    const qrcode = new QRCode(qrContainer, {
        text: frame.data,
        width: 300,
        height: 300,
        correctLevel: QRCode.CorrectLevel.L
    });
}

// 次のフレームを表示
function displayNextFrame() {
    if (!isTransmitting || qrFrames.length === 0) {
        return;
    }
    
    const frame = qrFrames[currentFrameIndex];
    
    // フレーム情報更新（ヘッダーを除外して表示）
    if (frame.type === 'header') {
        currentFrame.textContent = 'H';
        frameNumber.textContent = 'H';
    } else {
        currentFrame.textContent = frame.sequence;
        frameNumber.textContent = frame.sequence + ' / ' + (qrFrames.length - 1);
    }
    
    // QRコード生成と表示
    qrDisplay.innerHTML = '';
    
    // デバッグ: ライブラリ確認
    if (typeof QRCode === 'undefined') {
        console.error('QRCodeライブラリが読み込まれていません');
        alert('QRCodeライブラリの読み込みエラー');
        return;
    }
    
    // QRCode.jsライブラリを使用
    const qrContainer = document.createElement('div');
    qrDisplay.appendChild(qrContainer);
    
    // デバッグ: フレームデータサイズを表示
    const frameByteSize = Utils.getByteLength(frame.data);
    console.log(`フレーム${currentFrameIndex + 1} 総サイズ: ${frameByteSize}バイト（ASCII文字のみ）`);
    console.log(`フレームデータ: ${frame.data.substring(0, 100)}...`);
    
    // データフレームの場合、詳細なサイズ情報を表示
    if (frame.type === 'data') {
        const parsed = QRFormat.parse(frame.data);
        if (parsed && parsed.data) {
            const decodedDataSize = Utils.getByteLength(parsed.data);
            console.log(`  - デコード後データ: ${decodedDataSize}バイト`);
            console.log(`  - Base64エンコード比: ${(frameByteSize / decodedDataSize).toFixed(2)}倍`);
        }
    }
    
    const qrcode = new QRCode(qrContainer, {
        text: frame.data,
        width: 300,
        height: 300,
        correctLevel: QRCode.CorrectLevel.L  // エラー訂正レベルをLに下げて容量を増やす
    });
    
    // 次のフレームへ（一時停止中でなければ）
    if (!isPaused) {
        currentFrameIndex++;
        
        // 最後のフレームに到達した場合
        if (currentFrameIndex >= qrFrames.length) {
            // 送信完了処理
            clearInterval(transmissionInterval);
            transmissionInterval = null;
            isPaused = true;
            pauseButton.innerHTML = '▶ 再生';
            transmissionCompleteSection.style.display = 'block';
            return;
        }
        
        // ヘッダーをスキップ
        if (currentFrameIndex === 0) {
            currentFrameIndex = 1;
        }
    }
}

// 手動切り替え関数
function previousFrame() {
    if (!isTransmitting || qrFrames.length === 0) return;
    
    // 一時停止して手動操作
    isPaused = true;
    pauseButton.innerHTML = '▶ 再生';
    
    currentFrameIndex--;
    // ヘッダーをスキップ
    if (currentFrameIndex <= 0) {
        currentFrameIndex = qrFrames.length - 1;
    }
    displayCurrentFrame();
}

function nextFrame() {
    if (!isTransmitting || qrFrames.length === 0) return;
    
    // 一時停止して手動操作
    isPaused = true;
    pauseButton.innerHTML = '▶ 再生';
    
    currentFrameIndex++;
    if (currentFrameIndex >= qrFrames.length) {
        currentFrameIndex = 1; // ヘッダーをスキップ
    }
    displayCurrentFrame();
}

function togglePause() {
    isPaused = !isPaused;
    pauseButton.innerHTML = isPaused ? '▶ 再生' : '⏸ 一時停止';
    transmissionCompleteSection.style.display = 'none';
}

// フレームジャンプ機能
function jumpToFrame(frameNumber) {
    if (!isTransmitting || qrFrames.length === 0) return;
    
    // 一時停止して手動操作
    isPaused = true;
    pauseButton.innerHTML = '▶ 再生';
    
    // ヘッダーを考慮したインデックス計算
    if (frameNumber === 0) {
        currentFrameIndex = 0; // ヘッダー
    } else {
        currentFrameIndex = Math.max(1, Math.min(frameNumber, qrFrames.length - 1));
    }
    displayCurrentFrame();
}

function jumpToLastFrame() {
    if (!isTransmitting || qrFrames.length === 0) return;
    
    jumpToFrame(qrFrames.length);
}

// Wake Lock API（画面スリープ防止）
let wakeLock = null;

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('Wake Lock取得成功');
        }
    } catch (err) {
        console.log('Wake Lock取得失敗:', err);
    }
}

async function releaseWakeLock() {
    if (wakeLock !== null) {
        await wakeLock.release();
        wakeLock = null;
        console.log('Wake Lock解放');
    }
}

// 最初から再生
function restartFromBeginning() {
    if (!isTransmitting || qrFrames.length === 0) return;
    
    // インターバルをクリア
    if (transmissionInterval) {
        clearInterval(transmissionInterval);
    }
    
    // 最初のデータフレームから再開
    currentFrameIndex = 1;
    isPaused = false;
    pauseButton.innerHTML = '⏸ 一時停止';
    transmissionCompleteSection.style.display = 'none';
    
    displayCurrentFrame();
    
    // インターバル再設定
    const interval = parseInt(intervalSlider.value);
    transmissionInterval = setInterval(displayNextFrame, interval);
}

// ヘッダQR表示
function showHeader() {
    if (!isTransmitting || qrFrames.length === 0) return;
    
    // 一時停止して手動操作
    isPaused = true;
    pauseButton.innerHTML = '▶ 再生';
    transmissionCompleteSection.style.display = 'none';
    
    // ヘッダーフレームを表示
    currentFrameIndex = 0;
    displayCurrentFrame();
}

// グローバル関数として登録
window.startLoop = startLoop;
window.previousFrame = previousFrame;
window.nextFrame = nextFrame;
window.togglePause = togglePause;
window.displayCurrentFrame = displayCurrentFrame;
window.jumpToFrame = jumpToFrame;
window.jumpToLastFrame = jumpToLastFrame;
window.newTransmission = newTransmission;
window.restartFromBeginning = restartFromBeginning;
window.showHeader = showHeader;

// 送信開始時にWake Lockを取得
window.addEventListener('load', () => {
    // 送信開始時の処理を修正
    const originalStart = window.startTransmission;
    window.startTransmission = async function() {
        await requestWakeLock();
        await originalStart();
    };
    
    const originalStop = window.stopTransmission;
    window.stopTransmission = async function() {
        originalStop();
        await releaseWakeLock();
    };
});