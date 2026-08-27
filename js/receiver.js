// 受信側アプリケーションのロジック

const JSQR_SCAN_INTERVAL = 90;
const NATIVE_SCAN_INTERVAL = 60;
const JSQR_MAX_DIMENSION = 1440;

let video = null;
let canvas = null;
let context = null;
let scanning = false;
let currentStream = null;
let videoFrameCallbackId = null;
let animationFrameId = null;
let scanInFlight = false;
let lastScanTime = 0;
let scanAttempt = 0;
let barcodeDetector = null;

let headerInfo = null;
let receivedFrames = new Map();
let parityFrames = new Map();
let recoveredFrames = new Set();
let expectedFrames = 0;
let receiveCompleting = false;

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
const videoSource = document.getElementById('videoSource');
const refreshDevicesButton = document.getElementById('refreshDevices');
const deviceHint = document.getElementById('deviceHint');

initializeDeviceControls();

async function startScanning() {
    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            showError('このブラウザではカメラ機能が利用できません');
            return;
        }

        video = document.getElementById('video');
        canvas = document.getElementById('canvas');
        context = canvas.getContext('2d', { willReadFrequently: true });
        barcodeDetector = await createBarcodeDetector();

        const stream = await navigator.mediaDevices.getUserMedia(buildVideoConstraints());
        currentStream = stream;
        video.srcObject = stream;

        video.onloadedmetadata = () => {
            startButton.style.display = 'none';
            stopButton.style.display = 'inline-block';
            cameraContainer.style.display = 'block';
            errorMessage.style.display = 'none';
            setDeviceControlsEnabled(false);
            updateScanStatus('QRコードをスキャン');

            scanning = true;
            lastScanTime = 0;
            scanAttempt = 0;
            scheduleScan();
        };

        updateDeviceList(false);
        await requestWakeLock();
    } catch (error) {
        console.error('カメラアクセスエラー:', error);
        showError('カメラへのアクセスが拒否されました。カメラの使用を許可してください。');
        setDeviceControlsEnabled(true);
    }
}

function cancelScanSchedule() {
    if (video && videoFrameCallbackId != null && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(videoFrameCallbackId);
    }
    if (animationFrameId != null) cancelAnimationFrame(animationFrameId);
    videoFrameCallbackId = null;
    animationFrameId = null;
}

function stopScanning() {
    scanning = false;
    cancelScanSchedule();

    if (video && video.srcObject) {
        video.srcObject.getTracks().forEach(track => track.stop());
        video.srcObject = null;
    }
    currentStream = null;

    startButton.style.display = 'inline-block';
    stopButton.style.display = 'none';
    cameraContainer.style.display = 'none';
    progressContainer.style.display = 'none';
    readyMessage.style.display = 'none';
    setDeviceControlsEnabled(true);
    releaseWakeLock();
}

async function createBarcodeDetector() {
    if (!('BarcodeDetector' in window)) return null;
    try {
        if (typeof BarcodeDetector.getSupportedFormats === 'function') {
            const formats = await BarcodeDetector.getSupportedFormats();
            if (!formats.includes('qr_code')) return null;
        }
        return new BarcodeDetector({ formats: ['qr_code'] });
    } catch (error) {
        console.warn('ネイティブQR検出を利用できません:', error);
        return null;
    }
}

function scheduleScan() {
    if (!scanning || !video) return;

    if (typeof video.requestVideoFrameCallback === 'function') {
        videoFrameCallbackId = video.requestVideoFrameCallback(async (now) => {
            videoFrameCallbackId = null;
            await scanVideoFrame(now);
            scheduleScan();
        });
    } else {
        animationFrameId = requestAnimationFrame(async (now) => {
            animationFrameId = null;
            await scanVideoFrame(now);
            scheduleScan();
        });
    }
}

async function scanVideoFrame(now) {
    if (!scanning || scanInFlight || !video || video.readyState < video.HAVE_CURRENT_DATA) return;

    const minimumInterval = barcodeDetector ? NATIVE_SCAN_INTERVAL : JSQR_SCAN_INTERVAL;
    if (now - lastScanTime < minimumInterval) return;
    lastScanTime = now;
    scanInFlight = true;

    try {
        await scanQRCode();
    } finally {
        scanInFlight = false;
    }
}

async function scanQRCode() {
    scanAttempt++;

    if (barcodeDetector) {
        try {
            const barcodes = await barcodeDetector.detect(video);
            if (barcodes.length > 0) {
                processQRCode(barcodes[0].rawValue);
                return;
            }

            // ネイティブ検出で見つからない場合も、4回に1回はjsQRで補完する。
            if (scanAttempt % 4 !== 0) return;
        } catch (error) {
            console.warn('ネイティブQR検出を停止してjsQRへ切り替えます:', error);
            barcodeDetector = null;
        }
    }

    scanWithJsQr();
}

function scanWithJsQr() {
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    if (!sourceWidth || !sourceHeight) return;

    // 通常は中央を高速走査し、4回に1回だけ全画面を走査する。
    const scanFullFrame = scanAttempt % 4 === 0;
    const cropRatio = scanFullFrame ? 1 : 0.8;
    const cropWidth = Math.floor(sourceWidth * cropRatio);
    const cropHeight = Math.floor(sourceHeight * cropRatio);
    const sourceX = Math.floor((sourceWidth - cropWidth) / 2);
    const sourceY = Math.floor((sourceHeight - cropHeight) / 2);
    const scale = Math.min(1, JSQR_MAX_DIMENSION / Math.max(cropWidth, cropHeight));
    const targetWidth = Math.max(1, Math.floor(cropWidth * scale));
    const targetHeight = Math.max(1, Math.floor(cropHeight * scale));

    if (canvas.width !== targetWidth) canvas.width = targetWidth;
    if (canvas.height !== targetHeight) canvas.height = targetHeight;
    context.drawImage(
        video,
        sourceX, sourceY, cropWidth, cropHeight,
        0, 0, targetWidth, targetHeight
    );

    const imageData = context.getImageData(0, 0, targetWidth, targetHeight);
    const code = jsQR(imageData.data, targetWidth, targetHeight, {
        inversionAttempts: 'dontInvert'
    });
    if (code) processQRCode(code.data);
}

function processQRCode(data) {
    const parsed = QRFormat.parse(data);
    if (!parsed) return;

    if (parsed.type === QR_TYPE.HEADER) {
        processHeader(parsed);
    } else if (parsed.type === QR_TYPE.DATA) {
        processDataFrame(parsed);
    } else if (parsed.type === QR_TYPE.PARITY) {
        processParityFrame(parsed);
    }
}

function processHeader(parsed) {
    if (headerInfo && headerInfo.dataHash === parsed.dataHash) {
        updateScanStatus('準備完了');
        return;
    }

    if (parsed.version === 'v2') {
        const validV2Header = Number.isInteger(parsed.transferSize) && parsed.transferSize > 0
            && Number.isInteger(parsed.chunkSize) && parsed.chunkSize > 0
            && Number.isInteger(parsed.fecGroupSize) && parsed.fecGroupSize > 0
            && parsed.fecParityCount === 2;
        if (!validV2Header) return;
    }

    headerInfo = parsed;
    receivedFrames.clear();
    parityFrames.clear();
    recoveredFrames.clear();
    receiveCompleting = false;
    expectedFrames = parsed.totalFrames - 1;

    readyMessage.style.display = 'block';
    progressContainer.style.display = 'block';
    errorMessage.style.display = 'none';
    updateProgress();
    updateScanStatus('準備完了');
}

function frameMatchesCurrentSession(parsed) {
    if (!headerInfo) return false;
    if (parsed.version === 'v2') return parsed.sessionId === headerInfo.dataHash;
    return headerInfo.version !== 'v2';
}

function processDataFrame(parsed) {
    if (!frameMatchesCurrentSession(parsed)) return;
    if (parsed.sequence < 1 || parsed.sequence > expectedFrames) return;
    if (Utils.calculateCRC(parsed.data) !== parsed.crc) return;
    if (receivedFrames.has(parsed.sequence)) return;

    try {
        const frameData = parsed.version === 'v2'
            ? Utils.base64ToBytes(parsed.data)
            : parsed.data;
        receivedFrames.set(parsed.sequence, frameData);
        attemptFecRecovery();
        afterFrameReceived();
    } catch (error) {
        console.warn('データQRのデコードに失敗しました:', error);
    }
}

function processParityFrame(parsed) {
    if (!frameMatchesCurrentSession(parsed) || headerInfo.version !== 'v2') return;
    if (parsed.parityIndex < 0 || parsed.parityIndex >= headerInfo.fecParityCount) return;
    const maxGroup = Math.ceil(expectedFrames / headerInfo.fecGroupSize);
    if (parsed.group < 0 || parsed.group >= maxGroup) return;
    if (Utils.calculateCRC(parsed.data) !== parsed.crc) return;

    try {
        if (!parityFrames.has(parsed.group)) parityFrames.set(parsed.group, new Map());
        parityFrames.get(parsed.group).set(parsed.parityIndex, Utils.base64ToBytes(parsed.data));
        attemptFecRecovery();
        afterFrameReceived();
    } catch (error) {
        console.warn('復元用QRのデコードに失敗しました:', error);
    }
}

function expectedChunkLength(sequence) {
    const offset = (sequence - 1) * headerInfo.chunkSize;
    return Math.min(headerInfo.chunkSize, headerInfo.transferSize - offset);
}

function calculateParityResidual(group, parityIndex, missingSequences) {
    const groupParity = parityFrames.get(group);
    if (!groupParity || !groupParity.has(parityIndex)) return null;

    const residual = groupParity.get(parityIndex).slice();
    const startSequence = group * headerInfo.fecGroupSize + 1;
    const endSequence = Math.min(startSequence + headerInfo.fecGroupSize, expectedFrames + 1);
    const missingSet = new Set(missingSequences);

    for (let sequence = startSequence; sequence < endSequence; sequence++) {
        if (missingSet.has(sequence)) continue;
        const chunk = receivedFrames.get(sequence);
        if (!(chunk instanceof Uint8Array)) return null;
        const localIndex = sequence - startSequence;
        const coefficient = parityIndex === 0 ? 1 : Utils.fecCoefficient(localIndex);
        for (let position = 0; position < chunk.length; position++) {
            residual[position] ^= parityIndex === 0
                ? chunk[position]
                : Utils.gfMultiply(chunk[position], coefficient);
        }
    }
    return residual;
}

function attemptFecRecovery() {
    if (!headerInfo || headerInfo.version !== 'v2') return;
    const groupCount = Math.ceil(expectedFrames / headerInfo.fecGroupSize);

    for (let group = 0; group < groupCount; group++) {
        const startSequence = group * headerInfo.fecGroupSize + 1;
        const endSequence = Math.min(startSequence + headerInfo.fecGroupSize, expectedFrames + 1);
        const missing = [];
        for (let sequence = startSequence; sequence < endSequence; sequence++) {
            if (!receivedFrames.has(sequence)) missing.push(sequence);
        }

        if (missing.length === 1) recoverSingleMissingFrame(group, startSequence, missing[0]);
        else if (missing.length === 2) recoverTwoMissingFrames(group, startSequence, missing);
    }
}

function recoverSingleMissingFrame(group, startSequence, missingSequence) {
    let recovered = calculateParityResidual(group, 0, [missingSequence]);
    if (!recovered) {
        recovered = calculateParityResidual(group, 1, [missingSequence]);
        if (!recovered) return;
        const coefficient = Utils.fecCoefficient(missingSequence - startSequence);
        for (let position = 0; position < recovered.length; position++) {
            recovered[position] = Utils.gfDivide(recovered[position], coefficient);
        }
    }

    receivedFrames.set(missingSequence, recovered.slice(0, expectedChunkLength(missingSequence)));
    recoveredFrames.add(missingSequence);
}

function recoverTwoMissingFrames(group, startSequence, missing) {
    const residual0 = calculateParityResidual(group, 0, missing);
    const residual1 = calculateParityResidual(group, 1, missing);
    if (!residual0 || !residual1) return;

    const coefficientA = Utils.fecCoefficient(missing[0] - startSequence);
    const coefficientB = Utils.fecCoefficient(missing[1] - startSequence);
    const denominator = coefficientA ^ coefficientB;
    const recoveredA = new Uint8Array(headerInfo.chunkSize);
    const recoveredB = new Uint8Array(headerInfo.chunkSize);

    for (let position = 0; position < headerInfo.chunkSize; position++) {
        const numerator = residual1[position] ^ Utils.gfMultiply(coefficientB, residual0[position]);
        recoveredA[position] = Utils.gfDivide(numerator, denominator);
        recoveredB[position] = residual0[position] ^ recoveredA[position];
    }

    receivedFrames.set(missing[0], recoveredA.slice(0, expectedChunkLength(missing[0])));
    receivedFrames.set(missing[1], recoveredB.slice(0, expectedChunkLength(missing[1])));
    recoveredFrames.add(missing[0]);
    recoveredFrames.add(missing[1]);
}

function afterFrameReceived() {
    if (readyMessage.style.display !== 'none') readyMessage.style.display = 'none';
    errorMessage.style.display = 'none';
    updateScanStatus(recoveredFrames.size ? `${recoveredFrames.size}枚を自動復元` : 'スキャン中...');
    updateProgress();

    if (receivedFrames.size === expectedFrames && !receiveCompleting) onReceiveComplete();
}

function updateProgress() {
    const received = receivedFrames.size;
    const total = expectedFrames;
    const percent = total > 0 ? Math.round((received / total) * 100) : 0;

    receivedCount.textContent = received;
    totalCount.textContent = total || '?';
    progressFillInline.style.width = percent + '%';
    frameStatus.innerHTML = '';

    if (total <= 0) return;
    if (total > 300) {
        const missingCount = total - received;
        if (missingCount > 0 && missingCount <= 100) {
            const missing = [];
            for (let sequence = 1; sequence <= total; sequence++) {
                if (!receivedFrames.has(sequence)) missing.push(sequence);
            }
            frameStatus.textContent = `未受信: ${missing.join(', ')}`;
        } else {
            const recoveredText = recoveredFrames.size ? ` / 自動復元 ${recoveredFrames.size}枚` : '';
            frameStatus.textContent = `長文モード: ${received} / ${total}${recoveredText}`;
        }
        return;
    }
    const headerIndicator = document.createElement('div');
    headerIndicator.className = 'frame-indicator header';
    headerIndicator.textContent = 'H';
    frameStatus.appendChild(headerIndicator);

    for (let sequence = 1; sequence <= total; sequence++) {
        const indicator = document.createElement('div');
        indicator.className = 'frame-indicator';
        indicator.textContent = sequence;
        indicator.title = `データ ${sequence}`;
        if (receivedFrames.has(sequence)) indicator.classList.add('received');
        if (recoveredFrames.has(sequence)) {
            indicator.classList.add('recovered');
            indicator.title += '（自動復元）';
        }
        frameStatus.appendChild(indicator);
    }
}

async function onReceiveComplete() {
    receiveCompleting = true;
    stopScanning();

    try {
        let reconstructedData;
        if (headerInfo.version === 'v2') {
            const orderedChunks = [];
            for (let sequence = 1; sequence <= expectedFrames; sequence++) {
                orderedChunks.push(receivedFrames.get(sequence));
            }
            const transferBytes = Utils.concatenateBytes(orderedChunks, headerInfo.transferSize);
            reconstructedData = await Utils.decodeTransferBytes(transferBytes, headerInfo.encoding);
        } else {
            reconstructedData = '';
            for (let sequence = 1; sequence <= expectedFrames; sequence++) {
                reconstructedData += receivedFrames.get(sequence);
            }
        }

        if (Utils.getByteLength(reconstructedData) !== headerInfo.dataSize
            || Utils.calculateHash(reconstructedData) !== headerInfo.dataHash) {
            throw new Error('データの整合性チェックに失敗しました');
        }

        progressContainer.style.display = 'none';
        resultSection.style.display = 'block';
        receivedText.textContent = reconstructedData;
        errorMessage.style.display = 'none';
    } catch (error) {
        console.error('データ復元エラー:', error);
        showError(error.message || 'データの復元に失敗しました');
    }
}

async function copyToClipboard() {
    try {
        await navigator.clipboard.writeText(receivedText.textContent);
        alert('テキストをクリップボードにコピーしました');
    } catch (error) {
        const range = document.createRange();
        range.selectNodeContents(receivedText);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand('copy');
        selection.removeAllRanges();
    }
}

async function shareText() {
    const text = receivedText.textContent;
    if (navigator.share) {
        try {
            await navigator.share({ title: 'QRコードで受信したテキスト', text });
            return;
        } catch (error) {
            if (error.name === 'AbortError') return;
        }
    }
    await fallbackShare(text);
}

async function fallbackShare(text) {
    try {
        await navigator.clipboard.writeText(text);
        alert('共有機能が利用できないため、テキストをクリップボードにコピーしました');
    } catch (error) {
        alert('共有に失敗しました');
    }
}

function resetReceiver() {
    headerInfo = null;
    receivedFrames.clear();
    parityFrames.clear();
    recoveredFrames.clear();
    expectedFrames = 0;
    receiveCompleting = false;

    resultSection.style.display = 'none';
    progressContainer.style.display = 'none';
    readyMessage.style.display = 'none';
    errorMessage.style.display = 'none';
    updateProgress();
}

function setDeviceControlsEnabled(enabled) {
    if (!videoSource || !refreshDevicesButton) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        videoSource.disabled = true;
        refreshDevicesButton.disabled = true;
        return;
    }
    videoSource.disabled = !enabled;
    refreshDevicesButton.disabled = !enabled;
}

function getSelectedDeviceId() {
    if (!videoSource) return null;
    const value = videoSource.value;
    return !value || value === 'auto' || value === 'none' ? null : value;
}

function buildVideoConstraints() {
    const selectedId = getSelectedDeviceId();
    const videoConstraints = {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30, max: 30 }
    };
    if (selectedId) videoConstraints.deviceId = { exact: selectedId };
    else videoConstraints.facingMode = 'environment';
    return { video: videoConstraints };
}

function updateDeviceHint(message) {
    if (deviceHint) deviceHint.textContent = message;
}

async function updateDeviceList(requestPermission = false) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices || !videoSource) {
        updateDeviceHint('このブラウザではデバイス選択が利用できません');
        setDeviceControlsEnabled(false);
        return;
    }

    let permissionError = null;
    if (requestPermission) {
        try {
            const tempStream = await navigator.mediaDevices.getUserMedia({ video: true });
            tempStream.getTracks().forEach(track => track.stop());
        } catch (error) {
            permissionError = error;
        }
    }

    let devices;
    try {
        devices = await navigator.mediaDevices.enumerateDevices();
    } catch (error) {
        updateDeviceHint('デバイス一覧の取得に失敗しました');
        return;
    }

    const videoDevices = devices.filter(device => device.kind === 'videoinput');
    const previousValue = videoSource.value;
    videoSource.innerHTML = '';

    const autoOption = document.createElement('option');
    autoOption.value = 'auto';
    autoOption.textContent = '自動（背面優先）';
    videoSource.appendChild(autoOption);

    if (!videoDevices.length) {
        updateDeviceHint('利用可能なカメラ/キャプチャが見つかりません');
        return;
    }

    let hasLabel = false;
    videoDevices.forEach((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `カメラ ${index + 1}`;
        if (device.label) hasLabel = true;
        videoSource.appendChild(option);
    });

    const availableValues = Array.from(videoSource.options).map(option => option.value);
    videoSource.value = availableValues.includes(previousValue) ? previousValue : 'auto';
    if (permissionError || !hasLabel) updateDeviceHint('「一覧更新」で許可するとカメラ名が表示されます');
    else updateDeviceHint(`ビデオ入力: ${videoDevices.length}件`);
}

async function initializeDeviceControls() {
    if (!videoSource || !refreshDevicesButton || !deviceHint) return;
    refreshDevicesButton.addEventListener('click', () => updateDeviceList(true));
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
        navigator.mediaDevices.addEventListener('devicechange', () => {
            if (!scanning) updateDeviceList(false);
        });
    }
    await updateDeviceList(false);
}

function showError(message) {
    errorMessage.textContent = message;
    errorMessage.style.display = 'block';
}

let wakeLock = null;
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    } catch (error) {
        console.warn('Wake Lock取得失敗:', error);
    }
}

async function releaseWakeLock() {
    if (wakeLock) {
        await wakeLock.release();
        wakeLock = null;
    }
}

function updateScanStatus(message) {
    if (scanStatus) scanStatus.textContent = message;
}

window.startScanning = startScanning;
window.stopScanning = stopScanning;
window.copyToClipboard = copyToClipboard;
window.shareText = shareText;
window.resetReceiver = resetReceiver;
