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
const stopButton = document.getElementById('stopButton');
const qrDisplay = document.getElementById('qrDisplay');
const frameInfo = document.getElementById('frameInfo');
const currentFrame = document.getElementById('currentFrame');
const totalFrames = document.getElementById('totalFrames');
const frameInfoLarge = document.getElementById('frameInfoLarge');
const currentFrameLarge = document.getElementById('currentFrameLarge');
const totalFramesLarge = document.getElementById('totalFramesLarge');
const frameType = document.getElementById('frameType');
const manualControls = document.getElementById('manualControls');
const pauseButton = document.getElementById('pauseButton');
const frameDebugInfo = document.getElementById('frameDebugInfo');
const frameDebugLog = document.getElementById('frameDebugLog');

// フレームデバッグ機能
let frameDebugEnabled = false;

function toggleFrameDebug() {
    frameDebugEnabled = !frameDebugEnabled;
    frameDebugInfo.style.display = frameDebugEnabled ? 'block' : 'none';
    if (frameDebugEnabled && isTransmitting) {
        displayFrameDebugInfo();
    }
}

function displayFrameDebugInfo() {
    if (!frameDebugEnabled || !isTransmitting || qrFrames.length === 0) return;
    
    const frame = qrFrames[currentFrameIndex];
    let debugText = `フレーム${currentFrameIndex + 1}/${qrFrames.length}\n`;
    debugText += `タイプ: ${frame.type}\n`;
    
    if (frame.type === 'header') {
        debugText += `データ: ${frame.data}\n`;
    } else {
        debugText += `シーケンス: ${frame.sequence}\n`;
        debugText += `QRサイズ: ${Utils.getByteLength(frame.data)}バイト\n`;
        debugText += `データ: ${frame.data.substring(0, 100)}...\n`;
        
        // Base64デコードしてみる
        const parsed = QRFormat.parse(frame.data);
        if (parsed && parsed.data) {
            debugText += `デコード後: ${parsed.data.substring(0, 50)}...\n`;
        }
    }
    
    frameDebugLog.textContent = debugText;
}

// イベントリスナーの設定
inputText.addEventListener('input', updateTextInfo);
intervalSlider.addEventListener('input', updateIntervalDisplay);

// テキスト情報の更新
function updateTextInfo() {
    const text = inputText.value;
    charCount.textContent = text.length;
    byteCount.textContent = Utils.getByteLength(text);
}

// 表示間隔の更新
function updateIntervalDisplay() {
    intervalValue.textContent = intervalSlider.value;
}

// 送信開始
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
        isTransmitting = true;
        
        // UI更新
        startButton.style.display = 'none';
        stopButton.style.display = 'inline-block';
        frameInfo.style.display = 'block';
        frameInfoLarge.style.display = 'block';
        manualControls.style.display = 'flex';
        totalFrames.textContent = qrFrames.length;
        totalFramesLarge.textContent = qrFrames.length;
        
        // 表示開始
        displayNextFrame();
        
        // インターバル設定
        const interval = parseInt(intervalSlider.value);
        transmissionInterval = setInterval(displayNextFrame, interval);
        
    } catch (error) {
        console.error('QRコード生成エラー:', error);
        alert('QRコードの生成に失敗しました: ' + error.message);
    }
}

// 送信停止
function stopTransmission() {
    isTransmitting = false;
    
    if (transmissionInterval) {
        clearInterval(transmissionInterval);
        transmissionInterval = null;
    }
    
    // UI更新
    startButton.style.display = 'inline-block';
    stopButton.style.display = 'none';
    frameInfo.style.display = 'none';
    frameInfoLarge.style.display = 'none';
    manualControls.style.display = 'none';
    qrDisplay.innerHTML = '<p>QRコードがここに表示されます</p>';
    isPaused = false;
    pauseButton.textContent = '一時停止';
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
    
    console.log(`テキスト分割数: ${chunks.length}`);
    chunks.forEach((chunk, i) => {
        console.log(`チャンク${i+1}: ${Utils.getByteLength(chunk)}バイト`);
    });
    
    // ヘッダーQRコード生成
    // 総フレーム数 = ヘッダー(1) + データフレーム(chunks.length) = chunks.length + 1
    const totalFrameCount = chunks.length + 1;
    const headerData = QRFormat.createHeader(totalFrameCount, dataSize, dataHash);
    console.log(`フレーム生成: ヘッダー1個 + データ${chunks.length}個 = 総計${totalFrameCount}フレーム`);
    frames.push({
        type: 'header',
        data: headerData
    });
    
    // データQRコード生成
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const crc = Utils.calculateCRC(chunk);
        const dataQR = QRFormat.createData(i + 1, chunk, crc);
        
        console.log(`データフレーム${i + 1}: データサイズ${Utils.getByteLength(chunk)}バイト, QRサイズ${Utils.getByteLength(dataQR)}バイト`);
        if (i === chunks.length - 1) {
            console.log(`最後のフレーム詳細: seq=${i + 1}, data="${chunk.substring(0, 50)}...", crc=${crc}`);
        }
        
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
    
    // フレーム情報更新
    currentFrame.textContent = currentFrameIndex + 1;
    currentFrameLarge.textContent = currentFrameIndex + 1;
    
    // フレームタイプ表示
    if (frame.type === 'header') {
        frameType.textContent = 'ヘッダーフレーム';
    } else {
        frameType.textContent = `データフレーム ${frame.sequence}`;
    }
    
    // フレームデバッグ情報更新
    displayFrameDebugInfo();
    
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
}

// 次のフレームを表示
function displayNextFrame() {
    if (!isTransmitting || qrFrames.length === 0) {
        return;
    }
    
    const frame = qrFrames[currentFrameIndex];
    
    // フレーム情報更新
    currentFrame.textContent = currentFrameIndex + 1;
    currentFrameLarge.textContent = currentFrameIndex + 1;
    
    // フレームタイプ表示
    if (frame.type === 'header') {
        frameType.textContent = 'ヘッダーフレーム';
    } else {
        frameType.textContent = `データフレーム ${frame.sequence}`;
    }
    
    // フレームデバッグ情報更新
    displayFrameDebugInfo();
    
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
        const prevIndex = currentFrameIndex;
        currentFrameIndex = (currentFrameIndex + 1) % qrFrames.length;
        console.log(`自動送り: フレーム${prevIndex + 1} → フレーム${currentFrameIndex + 1}`);
    } else {
        console.log(`一時停止中: フレーム${currentFrameIndex + 1}に留まる`);
    }
}

// 手動切り替え関数
function previousFrame() {
    if (!isTransmitting || qrFrames.length === 0) return;
    
    // 一時停止して手動操作
    isPaused = true;
    pauseButton.textContent = '再開';
    
    currentFrameIndex = (currentFrameIndex - 1 + qrFrames.length) % qrFrames.length;
    displayCurrentFrame();
}

function nextFrame() {
    if (!isTransmitting || qrFrames.length === 0) return;
    
    // 一時停止して手動操作
    isPaused = true;
    pauseButton.textContent = '再開';
    
    currentFrameIndex = (currentFrameIndex + 1) % qrFrames.length;
    displayCurrentFrame();
}

function togglePause() {
    isPaused = !isPaused;
    pauseButton.textContent = isPaused ? '再開' : '一時停止';
    
    if (!isPaused && isTransmitting) {
        // 再開時は次のフレームに進む
        console.log(`再開: フレーム${currentFrameIndex + 1}から自動送り再開`);
        // 注: インターバルタイマーが自動的に次のフレームに進むので、ここではインデックスを変更しない
    } else if (isPaused) {
        console.log(`一時停止: フレーム${currentFrameIndex + 1}で停止`);
    }
}

// フレームジャンプ機能
function jumpToFrame(frameNumber) {
    if (!isTransmitting || qrFrames.length === 0) return;
    
    // 一時停止して手動操作
    isPaused = true;
    pauseButton.textContent = '再開';
    
    currentFrameIndex = Math.max(0, Math.min(frameNumber - 1, qrFrames.length - 1));
    displayCurrentFrame();
    console.log(`フレーム${frameNumber}にジャンプ`);
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

// グローバル関数として登録
window.previousFrame = previousFrame;
window.nextFrame = nextFrame;
window.togglePause = togglePause;
window.displayCurrentFrame = displayCurrentFrame;
window.jumpToFrame = jumpToFrame;
window.jumpToLastFrame = jumpToLastFrame;
window.toggleFrameDebug = toggleFrameDebug;

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