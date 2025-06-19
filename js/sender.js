// 送信側アプリケーションのロジック

let qrFrames = [];
let currentFrameIndex = 0;
let transmissionInterval = null;
let isTransmitting = false;

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
        totalFrames.textContent = qrFrames.length;
        
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
    qrDisplay.innerHTML = '<p>QRコードがここに表示されます</p>';
}

// QRコードフレームの生成
async function generateQRFrames(text) {
    const frames = [];
    
    // データのハッシュ計算
    const dataHash = Utils.calculateHash(text);
    const dataSize = Utils.getByteLength(text);
    
    // データ分割（QRコード容量を考慮）
    const maxDataSize = 800; // QRコードに含められる実データサイズ
    const chunks = Utils.splitData(text, maxDataSize);
    
    // ヘッダーQRコード生成
    const headerData = QRFormat.createHeader(chunks.length + 1, dataSize, dataHash);
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

// 次のフレームを表示
function displayNextFrame() {
    if (!isTransmitting || qrFrames.length === 0) {
        return;
    }
    
    const frame = qrFrames[currentFrameIndex];
    
    // フレーム情報更新
    currentFrame.textContent = currentFrameIndex + 1;
    
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
    
    const qrcode = new QRCode(qrContainer, {
        text: frame.data,
        width: 300,
        height: 300,
        correctLevel: QRCode.CorrectLevel.M
    });
    
    // 次のフレームへ
    currentFrameIndex = (currentFrameIndex + 1) % qrFrames.length;
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