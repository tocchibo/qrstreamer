// 送信側アプリケーションのロジック

const TRANSMISSION_PROFILES = {
    reliable: {
        label: '読み取り優先',
        chunkSize: 260,
        fecGroupSize: 8,
        fecParityCount: 2
    },
    balanced: {
        label: 'バランス',
        chunkSize: 330,
        fecGroupSize: 10,
        fecParityCount: 2
    },
    compact: {
        label: '枚数優先',
        chunkSize: 420,
        fecGroupSize: 12,
        fecParityCount: 2
    }
};
const QR_CORRECT_LEVEL = () => QRCode.CorrectLevel.M;

let qrFrames = [];
let dataFrameCount = 0;
let currentFrameIndex = 0;
let transmissionInterval = null;
let isTransmitting = false;
let isPaused = false;
let transmissionCompleted = false;

const inputText = document.getElementById('inputText');
const charCount = document.getElementById('charCount');
const byteCount = document.getElementById('byteCount');
const intervalSlider = document.getElementById('intervalSlider');
const intervalValue = document.getElementById('intervalValue');
const reliabilityMode = document.getElementById('reliabilityMode');
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
const secondaryControls = document.getElementById('secondaryControls');
const transmissionCompleteSection = document.getElementById('transmissionCompleteSection');
const startButtonContainer = document.getElementById('startButtonContainer');
const controlSection = document.getElementById('controlSection');
const qrContainerWrapper = document.querySelector('.qr-container');
const senderContainer = document.querySelector('.container.sender');
const transmissionSummary = document.getElementById('transmissionSummary');

let lastRenderedData = null;
let lastRenderedLevel = null;
let wakeLock = null;

inputText.addEventListener('input', updateTextInfo);
intervalSlider.addEventListener('input', updateIntervalDisplay);

document.addEventListener('keydown', (event) => {
    if (!isTransmitting) return;

    if (event.key === 'ArrowLeft') {
        event.preventDefault();
        previousFrame();
    } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        nextFrame();
    } else if (event.key === ' ') {
        event.preventDefault();
        togglePause();
    }
});

function updateTextInfo() {
    const text = inputText.value;
    charCount.textContent = text.length;
    byteCount.textContent = Utils.getByteLength(text);
}

function updateIntervalDisplay() {
    intervalValue.textContent = intervalSlider.value;
    if (isTransmitting && !isPaused && transmissionInterval) scheduleNextFrame();
}

function clearTransmissionTimer() {
    if (transmissionInterval) {
        clearTimeout(transmissionInterval);
        transmissionInterval = null;
    }
}

function getQrRenderSize() {
    if (!qrDisplay) return 300;

    const displayStyle = window.getComputedStyle(qrDisplay);
    const paddingX = parseFloat(displayStyle.paddingLeft) + parseFloat(displayStyle.paddingRight);
    const paddingY = parseFloat(displayStyle.paddingTop) + parseFloat(displayStyle.paddingBottom);
    const maxWidth = Math.max(180, qrDisplay.clientWidth - paddingX);
    let maxHeight = maxWidth;

    if (window.matchMedia('(min-width: 900px)').matches && qrContainerWrapper && senderContainer) {
        const containerRect = senderContainer.getBoundingClientRect();
        const qrContainerRect = qrContainerWrapper.getBoundingClientRect();
        const qrDisplayRect = qrDisplay.getBoundingClientRect();
        const aboveHeight = qrContainerRect.top - containerRect.top;
        const belowHeight = containerRect.bottom - qrContainerRect.bottom;
        const availableForQrContainer = window.innerHeight - aboveHeight - belowHeight - 16;
        const overhead = qrContainerRect.height - qrDisplayRect.height;
        const availableForQrDisplay = availableForQrContainer - overhead - paddingY;
        if (Number.isFinite(availableForQrDisplay)) maxHeight = Math.min(maxHeight, availableForQrDisplay);
    }

    return Math.floor(Math.max(180, Math.min(maxWidth, maxHeight)));
}

function getModuleCount(data, correctLevel) {
    const probeContainer = document.createElement('div');
    const probe = new QRCode(probeContainer, {
        text: data,
        width: 64,
        height: 64,
        correctLevel
    });
    return probe._oQRCode && typeof probe._oQRCode.getModuleCount === 'function'
        ? probe._oQRCode.getModuleCount()
        : null;
}

function suppressQrTooltips(target) {
    if (!target) return;
    target.querySelectorAll('[title]').forEach(node => node.removeAttribute('title'));
}

function renderQrCode(data, correctLevel) {
    if (typeof QRCode === 'undefined') {
        alert('QRCodeライブラリの読み込みエラー');
        return;
    }

    const maxSize = getQrRenderSize();
    const moduleCount = getModuleCount(data, correctLevel);
    // QR規格の4セル分の余白を確保し、セル幅を整数にして補間ぼけを防ぐ。
    const cellSize = moduleCount ? Math.max(1, Math.floor(maxSize / (moduleCount + 8))) : 1;
    const codeSize = moduleCount ? moduleCount * cellSize : Math.max(1, maxSize - 32);
    const quietZone = moduleCount ? cellSize * 4 : 16;

    lastRenderedData = data;
    lastRenderedLevel = correctLevel;
    qrDisplay.innerHTML = '';
    qrDisplay.classList.add('qr-active');

    const quietZoneContainer = document.createElement('div');
    quietZoneContainer.className = 'qr-quiet-zone';
    quietZoneContainer.style.padding = `${quietZone}px`;
    const codeContainer = document.createElement('div');
    quietZoneContainer.appendChild(codeContainer);
    qrDisplay.appendChild(quietZoneContainer);

    new QRCode(codeContainer, {
        text: data,
        width: codeSize,
        height: codeSize,
        correctLevel
    });
    suppressQrTooltips(codeContainer);
}

function resetQrDisplayState() {
    qrDisplay.classList.remove('qr-active');
    lastRenderedData = null;
    lastRenderedLevel = null;
}

async function startTransmission() {
    const text = inputText.value;
    if (!text.trim()) {
        alert('送信するテキストを入力してください');
        return;
    }

    try {
        startButton.disabled = true;
        startButton.textContent = '準備中...';
        await requestWakeLock();
        const generated = await generateQRFrames(text);
        qrFrames = generated.frames;
        dataFrameCount = generated.dataFrameCount;
        currentFrameIndex = 0;

        startButtonContainer.style.display = 'none';
        startTransmissionSection.style.display = 'block';
        newTransmissionButton.style.display = 'inline-block';
        senderContainer.classList.add('qr-mode');

        if (transmissionSummary) {
            const compressionText = generated.compressed ? '圧縮あり' : '圧縮なし';
            transmissionSummary.textContent = `${generated.profileLabel}・送信QR ${qrFrames.length - 1}枚（復元用QRを含む・${compressionText}）`;
        }
        displayHeaderOnly();
    } catch (error) {
        console.error('QRコード生成エラー:', error);
        alert('QRコードの生成に失敗しました: ' + error.message);
        startButton.disabled = false;
        startButton.textContent = '送信開始';
        await releaseWakeLock();
    }
}

function displayHeaderOnly() {
    if (!qrFrames.length) return;
    frameNumber.style.display = 'none';
    renderQrCode(qrFrames[0].data, QR_CORRECT_LEVEL());
}

function startLoop() {
    if (!qrFrames.length) return;

    isTransmitting = true;
    isPaused = false;
    transmissionCompleted = false;
    currentFrameIndex = 1;

    controlSection.style.display = 'none';
    frameInfo.style.display = 'block';
    frameNumber.style.display = 'block';
    manualControls.style.display = 'flex';
    secondaryControls.style.display = 'block';
    transmissionCompleteSection.style.display = 'none';
    totalFrames.textContent = qrFrames.length - 1;
    pauseButton.textContent = '⏸ 一時停止';

    displayCurrentFrame();
    scheduleNextFrame();
}

function scheduleNextFrame() {
    clearTransmissionTimer();
    if (!isTransmitting || isPaused) return;

    const interval = Number.parseInt(intervalSlider.value, 10);
    transmissionInterval = setTimeout(() => {
        transmissionInterval = null;
        displayNextFrame();
    }, interval);
}

function displayNextFrame() {
    if (!isTransmitting || isPaused || !qrFrames.length) return;

    if (currentFrameIndex >= qrFrames.length - 1) {
        transmissionCompleted = true;
        isPaused = true;
        pauseButton.textContent = '▶ 最初から再生';
        transmissionCompleteSection.style.display = 'block';
        return;
    }

    currentFrameIndex++;
    displayCurrentFrame();
    scheduleNextFrame();
}

function stopTransmission() {
    isTransmitting = false;
    clearTransmissionTimer();
}

async function newTransmission() {
    stopTransmission();
    await releaseWakeLock();

    controlSection.style.display = 'block';
    startButtonContainer.style.display = 'block';
    startButton.disabled = false;
    startButton.textContent = '送信開始';
    startTransmissionSection.style.display = 'none';
    newTransmissionButton.style.display = 'none';
    frameInfo.style.display = 'none';
    frameNumber.style.display = 'none';
    manualControls.style.display = 'none';
    secondaryControls.style.display = 'none';
    transmissionCompleteSection.style.display = 'none';
    senderContainer.classList.remove('qr-mode');
    qrDisplay.innerHTML = '<p>QRコードがここに表示されます</p>';
    resetQrDisplayState();
    isPaused = false;
    transmissionCompleted = false;
    pauseButton.textContent = '⏸ 一時停止';

    inputText.value = '';
    inputText.focus();
    updateTextInfo();
}

async function generateQRFrames(text) {
    const frames = [];
    const profile = TRANSMISSION_PROFILES[reliabilityMode.value] || TRANSMISSION_PROFILES.reliable;
    const dataHash = Utils.calculateHash(text);
    const dataSize = Utils.getByteLength(text);
    const transfer = await Utils.compressText(text);
    const chunks = Utils.splitBytes(transfer.bytes, profile.chunkSize);

    const headerData = QRFormat.createHeader(chunks.length + 1, dataSize, dataHash, transfer.encoding, {
        transferSize: transfer.bytes.length,
        chunkSize: profile.chunkSize,
        fecGroupSize: profile.fecGroupSize,
        fecParityCount: profile.fecParityCount
    });
    frames.push({ type: 'header', data: headerData });

    for (let groupStart = 0; groupStart < chunks.length; groupStart += profile.fecGroupSize) {
        const groupIndex = Math.floor(groupStart / profile.fecGroupSize);
        const groupChunks = chunks.slice(groupStart, groupStart + profile.fecGroupSize);

        groupChunks.forEach((chunk, localIndex) => {
            const sequence = groupStart + localIndex + 1;
            const encoded = Utils.bytesToBase64(chunk);
            frames.push({
                type: 'data',
                sequence,
                data: QRFormat.createData(sequence, encoded, Utils.calculateCRC(encoded), dataHash)
            });
        });

        const parityChunks = Utils.createParityChunks(groupChunks, profile.chunkSize);
        parityChunks.forEach((parity, parityIndex) => {
            const encoded = Utils.bytesToBase64(parity);
            frames.push({
                type: 'parity',
                group: groupIndex,
                parityIndex,
                data: QRFormat.createParity(groupIndex, parityIndex, encoded, Utils.calculateCRC(encoded), dataHash)
            });
        });

        if (groupIndex % 25 === 24) {
            await new Promise(resolve => requestAnimationFrame(resolve));
        }
    }

    frames.slice(1).forEach((frame, index) => {
        frame.displaySequence = index + 1;
    });

    return {
        frames,
        dataFrameCount: chunks.length,
        compressed: transfer.encoding === 'GZIP',
        profileLabel: profile.label
    };
}

function displayCurrentFrame() {
    if (!isTransmitting || !qrFrames.length) return;
    const frame = qrFrames[currentFrameIndex];

    if (frame.type === 'header') {
        currentFrame.textContent = 'H';
        frameNumber.textContent = '準備用QR';
    } else if (frame.type === 'data') {
        currentFrame.textContent = frame.displaySequence;
        frameNumber.textContent = `${frame.displaySequence} / ${qrFrames.length - 1}（データ ${frame.sequence} / ${dataFrameCount}）`;
    } else {
        currentFrame.textContent = frame.displaySequence;
        frameNumber.textContent = `${frame.displaySequence} / ${qrFrames.length - 1}（復元用QR）`;
    }

    renderQrCode(frame.data, QR_CORRECT_LEVEL());
}

function pauseForManualControl() {
    isPaused = true;
    transmissionCompleted = false;
    clearTransmissionTimer();
    pauseButton.textContent = '▶ 再生';
    transmissionCompleteSection.style.display = 'none';
}

function previousFrame() {
    if (!isTransmitting || !qrFrames.length) return;
    pauseForManualControl();
    currentFrameIndex--;
    if (currentFrameIndex <= 0) currentFrameIndex = qrFrames.length - 1;
    displayCurrentFrame();
}

function nextFrame() {
    if (!isTransmitting || !qrFrames.length) return;
    pauseForManualControl();
    currentFrameIndex++;
    if (currentFrameIndex >= qrFrames.length) currentFrameIndex = 1;
    displayCurrentFrame();
}

function togglePause() {
    if (!isTransmitting) return;

    if (!isPaused) {
        pauseForManualControl();
        return;
    }

    if (transmissionCompleted || currentFrameIndex === 0) {
        currentFrameIndex = 1;
        transmissionCompleted = false;
        displayCurrentFrame();
    }
    isPaused = false;
    pauseButton.textContent = '⏸ 一時停止';
    transmissionCompleteSection.style.display = 'none';
    scheduleNextFrame();
}

function jumpToFrame(requestedFrame) {
    if (!isTransmitting || !qrFrames.length) return;
    pauseForManualControl();
    currentFrameIndex = requestedFrame === 0
        ? 0
        : Math.max(1, Math.min(requestedFrame, qrFrames.length - 1));
    displayCurrentFrame();
}

function jumpToLastFrame() {
    jumpToFrame(qrFrames.length - 1);
}

function restartFromBeginning() {
    if (!isTransmitting || !qrFrames.length) return;
    clearTransmissionTimer();
    currentFrameIndex = 1;
    isPaused = false;
    transmissionCompleted = false;
    pauseButton.textContent = '⏸ 一時停止';
    transmissionCompleteSection.style.display = 'none';
    displayCurrentFrame();
    scheduleNextFrame();
}

function showHeader() {
    if (!isTransmitting || !qrFrames.length) return;
    pauseForManualControl();
    currentFrameIndex = 0;
    displayCurrentFrame();
}

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

window.startTransmission = startTransmission;
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

window.addEventListener('resize', () => {
    if (lastRenderedData) renderQrCode(lastRenderedData, lastRenderedLevel || QR_CORRECT_LEVEL());
});

window.addEventListener('beforeunload', () => {
    clearTransmissionTimer();
    releaseWakeLock();
});
