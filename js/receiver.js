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
const progressPercent = document.getElementById('progressPercent');
const progressFill = document.getElementById('progressFill');
const missingFrames = document.getElementById('missingFrames');
const frameStatus = document.getElementById('frameStatus');
const resultSection = document.getElementById('resultSection');
const receivedText = document.getElementById('receivedText');
const errorMessage = document.getElementById('errorMessage');
const debugInfo = document.getElementById('debugInfo');
const debugLog = document.getElementById('debugLog');
const debugToggleButton = document.getElementById('debugToggleButton');

// デバッグ機能
let debugEnabled = false;
function debugPrint(message) {
    console.log(message);
    if (debugEnabled && debugLog) {
        const timestamp = new Date().toLocaleTimeString();
        debugLog.innerHTML += `[${timestamp}] ${message}\n`;
        debugLog.scrollTop = debugLog.scrollHeight;
    }
}

function toggleDebug() {
    debugEnabled = !debugEnabled;
    debugInfo.style.display = debugEnabled ? 'block' : 'none';
    
    if (debugEnabled) {
        debugPrint('=== デバッグモード開始 ===');
        debugPrint(`現在時刻: ${new Date().toLocaleString()}`);
        debugPrint(`スキャン中: ${scanning}`);
        debugPrint(`ヘッダー情報: ${headerInfo ? 'あり' : 'なし'}`);
        debugPrint(`受信済みフレーム数: ${receivedFrames.size}`);
        debugPrint(`期待フレーム数: ${expectedFrames}`);
    } else {
        debugPrint('=== デバッグモード終了 ===');
    }
}

function testDebug() {
    debugPrint('デバッグテスト: この機能は正常に動作しています');
    debugPrint(`ブラウザ: ${navigator.userAgent}`);
    debugPrint(`画面サイズ: ${window.innerWidth}x${window.innerHeight}`);
    alert('デバッグテスト完了');
}

// スキャン開始
async function startScanning() {
    try {
        debugPrint('カメラアクセス開始...');
        
        // カメラアクセス
        video = document.getElementById('video');
        canvas = document.getElementById('canvas');
        context = canvas.getContext('2d');
        
        debugPrint('getUserMedia呼び出し...');
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: 'environment', // 背面カメラを優先
                width: { ideal: 1280 },
                height: { ideal: 720 }
            }
        });
        
        debugPrint('カメラストリーム取得成功');
        video.srcObject = stream;
        
        // ビデオのメタデータ読み込み完了を待つ
        video.addEventListener('loadedmetadata', () => {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            
            debugPrint(`ビデオサイズ: ${video.videoWidth}x${video.videoHeight}`);
            debugPrint('UI更新中...');
            
            // UI更新
            startButton.style.display = 'none';
            stopButton.style.display = 'inline-block';
            cameraContainer.style.display = 'block';
            progressContainer.style.display = 'block';
            errorMessage.style.display = 'none';
            
            // スキャン開始
            scanning = true;
            debugPrint('QRコードスキャン開始（100ms間隔）');
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
    
    // Wake Lock解放
    releaseWakeLock();
}

// QRコードスキャン
let scanCount = 0;
function scanQRCode() {
    scanCount++;
    
    if (!scanning || !video || video.readyState !== video.HAVE_ENOUGH_DATA) {
        if (scanCount % 50 === 0) { // 5秒ごとに状態ログ
            debugPrint(`スキャン待機中... (${scanCount}回目, readyState: ${video?.readyState})`);
        }
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
        debugPrint(`QRコード検出！(${scanCount}回目のスキャンで検出)`);
        processQRCode(code.data);
    } else if (scanCount % 100 === 0) { // 10秒ごとにスキャン状況をログ
        debugPrint(`QRコード未検出 (${scanCount}回スキャン済み)`);
    }
}

// QRコード処理
function processQRCode(data) {
    debugPrint(`QRコード読み取り: ${data.substring(0, 50)}...`);
    const parsed = QRFormat.parse(data);
    
    if (!parsed) {
        debugPrint(`無効なQRコードフォーマット: ${data}`);
        showError('無効なQRコードです');
        return;
    }
    
    if (parsed.type === QR_TYPE.HEADER) {
        // ヘッダー処理
        debugPrint(`ヘッダー受信: totalFrames=${parsed.totalFrames}, dataSize=${parsed.dataSize}, hash=${parsed.dataHash}`);
        if (!headerInfo || headerInfo.dataHash !== parsed.dataHash) {
            // 新しい転送セッション
            headerInfo = parsed;
            receivedFrames.clear();
            expectedFrames = parsed.totalFrames - 1; // ヘッダーを除く
            debugPrint(`新セッション開始: 総フレーム数=${parsed.totalFrames}（データフレーム数=${expectedFrames}）`);
            updateProgress();
        } else {
            debugPrint('同じヘッダーを再受信（無視）');
        }
    } else if (parsed.type === QR_TYPE.DATA) {
        // データフレーム処理
        if (!headerInfo) {
            debugPrint(`ヘッダー未受信のデータフレーム: seq=${parsed.sequence}`);
            showError('ヘッダーが受信されていません');
            return;
        }
        
        debugPrint(`データフレーム受信: seq=${parsed.sequence}, size=${Utils.getByteLength(parsed.data)}バイト`);
        
        // CRCチェック
        const calculatedCRC = Utils.calculateCRC(parsed.data);
        if (calculatedCRC !== parsed.crc) {
            debugPrint(`CRCエラー: seq=${parsed.sequence}, expected=${parsed.crc}, calculated=${calculatedCRC}`);
            showError(`フレーム${parsed.sequence}のデータエラー`);
            return;
        }
        
        // フレーム保存（重複は上書き）
        if (!receivedFrames.has(parsed.sequence)) {
            receivedFrames.set(parsed.sequence, parsed.data);
            debugPrint(`フレーム${parsed.sequence}を保存 (${receivedFrames.size}/${expectedFrames})`);
            updateProgress();
            
            // 完了チェック
            if (receivedFrames.size === expectedFrames) {
                debugPrint('全フレーム受信完了！');
                onReceiveComplete();
            }
        } else {
            debugPrint(`フレーム${parsed.sequence}は既に受信済み`);
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
    progressPercent.textContent = percent;
    progressFill.style.width = percent + '%';
    
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
    
    // 未受信フレーム表示
    if (received < total) {
        const missing = [];
        for (let i = 1; i <= total; i++) {
            if (!receivedFrames.has(i)) {
                missing.push(i);
            }
        }
        if (missing.length > 0 && missing.length <= 10) {
            missingFrames.textContent = '未受信: ' + missing.join(', ');
        } else if (missing.length > 10) {
            missingFrames.textContent = `未受信: ${missing.length}フレーム`;
        } else {
            missingFrames.textContent = '';
        }
    } else {
        missingFrames.textContent = '';
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
    progressContainer.style.display = 'none';
    resultSection.style.display = 'block';
    receivedText.textContent = reconstructedData;
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

// リセット
function resetReceiver() {
    headerInfo = null;
    receivedFrames.clear();
    expectedFrames = 0;
    
    resultSection.style.display = 'none';
    progressContainer.style.display = 'none';
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
            debugPrint('Wake Lock取得成功');
        }
    } catch (err) {
        debugPrint('Wake Lock取得失敗:' + err);
    }
}

async function releaseWakeLock() {
    if (wakeLock !== null) {
        await wakeLock.release();
        wakeLock = null;
        debugPrint('Wake Lock解放');
    }
}

// グローバル関数として登録
window.toggleDebug = toggleDebug;
window.testDebug = testDebug;

// ページ読み込み時の初期化
window.addEventListener('load', () => {
    // デバッグボタンのイベントリスナー設定
    if (debugToggleButton) {
        debugToggleButton.addEventListener('click', toggleDebug);
    }
    
    // 初期デバッグメッセージ
    debugPrint('受信アプリ初期化完了');
    debugPrint(`jsQRライブラリ: ${typeof jsQR !== 'undefined' ? '読み込み済み' : '読み込みエラー'}`);
    
    // デバッグを最初から有効にする（スマホでの確認用）
    setTimeout(() => {
        if (!debugEnabled) {
            toggleDebug();
        }
    }, 1000);
});