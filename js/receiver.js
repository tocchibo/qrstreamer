// 受信側アプリケーションのロジック

let video = null;
let canvas = null;
let context = null;
let scanning = false;
let scanInterval = null;

// 受信データ管理
let headerInfo = null;
let receivedFrames = new Map();
let expectedFrames = 0;

// DOM要素
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const cameraContainer = document.getElementById('cameraContainer');
const progressContainer = document.getElementById('progressContainer');
const receivedCount = document.getElementById('receivedCount');
const totalCount = document.getElementById('totalCount');
const progressFillInline = document.getElementById('progressFillInline');
const frameStatus = document.getElementById('frameStatus');
const resultSection = document.getElementById('resultSection');
const receivedText = document.getElementById('receivedText');
const errorMessage = document.getElementById('errorMessage');
const scanStatus = document.getElementById('scanStatus');
const readyMessage = document.getElementById('readyMessage');

// スキャン開始
async function startScanning() {
    try {
        // カメラアクセス
        video = document.getElementById('video');
        canvas = document.getElementById('canvas');
        context = canvas.getContext('2d');
        
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: 'environment', // 背面カメラを優先
                width: { ideal: 1280 },
                height: { ideal: 720 }
            }
        });
        
        video.srcObject = stream;
        
        // ビデオのメタデータ読み込み完了を待つ
        video.addEventListener('loadedmetadata', () => {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            
            // UI更新
            startButton.style.display = 'none';
            stopButton.style.display = 'inline-block';
            cameraContainer.style.display = 'block';
            errorMessage.style.display = 'none';
            updateScanStatus('QRコードをスキャン');
            
            // スキャン開始
            scanning = true;
            scanInterval = setInterval(scanQRCode, 100); // 100msごとにスキャン
        });
        
        // Wake Lock取得
        await requestWakeLock();
        
    } catch (error) {
        console.error('カメラアクセスエラー:', error);
        showError('カメラへのアクセスが拒否されました。カメラの使用を許可してください。');
    }
}

// スキャン停止
function stopScanning() {
    scanning = false;
    
    if (scanInterval) {
        clearInterval(scanInterval);
        scanInterval = null;
    }
    
    if (video && video.srcObject) {
        const tracks = video.srcObject.getTracks();
        tracks.forEach(track => track.stop());
        video.srcObject = null;
    }
    
    // UI更新
    startButton.style.display = 'inline-block';
    stopButton.style.display = 'none';
    cameraContainer.style.display = 'none';
    progressContainer.style.display = 'none';
    readyMessage.style.display = 'none';
    
    // Wake Lock解放
    releaseWakeLock();
}

// QRコードスキャン
function scanQRCode() {
    if (!scanning || !video || video.readyState !== video.HAVE_ENOUGH_DATA) {
        return;
    }
    
    // カメラ画像をcanvasに描画
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    
    // QRコード検出
    const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: "dontInvert"
    });
    
    if (code) {
        updateScanStatus('QRコード検出 - 処理中...');
        processQRCode(code.data);
    }
}

// QRコード処理
function processQRCode(data) {
    const parsed = QRFormat.parse(data);
    
    if (!parsed) {
        showError('無効なQRコードです');
        return;
    }
    
    if (parsed.type === QR_TYPE.HEADER) {
        // ヘッダー処理
        if (!headerInfo || headerInfo.dataHash !== parsed.dataHash) {
            // 新しい転送セッション
            headerInfo = parsed;
            receivedFrames.clear();
            expectedFrames = parsed.totalFrames - 1; // ヘッダーを除く
            
            // 準備完了メッセージを表示
            readyMessage.style.display = 'block';
            progressContainer.style.display = 'block';
            errorMessage.style.display = 'none'; // エラーメッセージをクリア
            updateProgress();
            updateScanStatus('スキャン中...');
        }
    } else if (parsed.type === QR_TYPE.DATA) {
        // データフレーム処理
        if (!headerInfo) {
            showError('ヘッダーが受信されていません');
            return;
        }
        
        // CRCチェック
        const calculatedCRC = Utils.calculateCRC(parsed.data);
        if (calculatedCRC !== parsed.crc) {
            showError(`フレーム${parsed.sequence}のデータエラー`);
            return;
        }
        
        // フレーム保存（重複は上書き）
        if (!receivedFrames.has(parsed.sequence)) {
            receivedFrames.set(parsed.sequence, parsed.data);
            
            // 準備完了メッセージを非表示
            if (readyMessage.style.display !== 'none') {
                readyMessage.style.display = 'none';
            }
            
            errorMessage.style.display = 'none'; // エラーメッセージをクリア
            updateScanStatus('スキャン中...');
            updateProgress();
            
            // 完了チェック
            if (receivedFrames.size === expectedFrames) {
                onReceiveComplete();
            }
        } else {
            updateScanStatus('スキャン中...');
        }
    }
}

// 進捗更新
function updateProgress() {
    const received = receivedFrames.size;
    const total = expectedFrames;
    const percent = total > 0 ? Math.round((received / total) * 100) : 0;
    
    receivedCount.textContent = received;
    totalCount.textContent = total;
    progressFillInline.style.width = percent + '%';
    
    // フレーム状況の可視化
    if (total > 0) {
        frameStatus.innerHTML = '';
        
        // ヘッダーフレーム
        const headerIndicator = document.createElement('div');
        headerIndicator.className = 'frame-indicator header';
        headerIndicator.textContent = 'H';
        headerIndicator.title = 'ヘッダーフレーム';
        frameStatus.appendChild(headerIndicator);
        
        // データフレーム
        for (let i = 1; i <= total; i++) {
            const indicator = document.createElement('div');
            indicator.className = 'frame-indicator';
            indicator.textContent = i;
            indicator.title = `フレーム ${i}`;
            
            if (receivedFrames.has(i)) {
                indicator.classList.add('received');
            }
            
            frameStatus.appendChild(indicator);
        }
    }
}

// 受信完了処理
async function onReceiveComplete() {
    stopScanning();
    
    // データ復元
    let reconstructedData = '';
    for (let i = 1; i <= expectedFrames; i++) {
        if (receivedFrames.has(i)) {
            reconstructedData += receivedFrames.get(i);
        } else {
            showError('データの復元に失敗しました（フレーム欠損）');
            return;
        }
    }
    
    // ハッシュ検証
    const calculatedHash = Utils.calculateHash(reconstructedData);
    if (calculatedHash !== headerInfo.dataHash) {
        showError('データの整合性チェックに失敗しました');
        return;
    }
    
    // 結果表示
    updateScanStatus('受信完了！');
    progressContainer.style.display = 'none';
    resultSection.style.display = 'block';
    receivedText.textContent = reconstructedData;
    errorMessage.style.display = 'none'; // エラーメッセージをクリア
}

// テキストをクリップボードにコピー
async function copyToClipboard() {
    try {
        await navigator.clipboard.writeText(receivedText.textContent);
        alert('テキストをクリップボードにコピーしました');
    } catch (error) {
        console.error('コピー失敗:', error);
        // フォールバック
        receivedText.select();
        document.execCommand('copy');
    }
}

// テキストを共有
async function shareText() {
    const text = receivedText.textContent;
    
    // Web Share APIが利用可能かチェック
    if (navigator.share) {
        try {
            await navigator.share({
                title: 'QRコードで受信したテキスト',
                text: text
            });
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error('共有エラー:', error);
                // フォールバック: クリップボードにコピー
                fallbackShare(text);
            }
        }
    } else {
        // Web Share APIが利用できない場合のフォールバック
        fallbackShare(text);
    }
}

// 共有のフォールバック処理
function fallbackShare(text) {
    try {
        navigator.clipboard.writeText(text);
        alert('共有機能が利用できないため、テキストをクリップボードにコピーしました');
    } catch (error) {
        console.error('フォールバック共有失敗:', error);
        alert('共有に失敗しました');
    }
}

// リセット
function resetReceiver() {
    headerInfo = null;
    receivedFrames.clear();
    expectedFrames = 0;
    
    resultSection.style.display = 'none';
    progressContainer.style.display = 'none';
    readyMessage.style.display = 'none';
    errorMessage.style.display = 'none';
    
    updateProgress();
}

// エラー表示
function showError(message) {
    errorMessage.textContent = message;
    errorMessage.style.display = 'block';
}

// Wake Lock API
let wakeLock = null;

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
        }
    } catch (err) {
        console.error('Wake Lock取得失敗:', err);
    }
}

async function releaseWakeLock() {
    if (wakeLock !== null) {
        await wakeLock.release();
        wakeLock = null;
    }
}

// スキャン状態更新
function updateScanStatus(message) {
    if (scanStatus) {
        scanStatus.textContent = message;
    }
}