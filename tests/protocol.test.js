const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');

global.window = global;
global.sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
global.CRC32 = {
    str(value) {
        let hash = 0;
        for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
        return hash;
    }
};

vm.runInThisContext(fs.readFileSync('js/common.js', 'utf8'), { filename: 'js/common.js' });

function recoverTwo(chunks, parity, missingA, missingB, chunkSize) {
    const residual0 = parity[0].slice();
    const residual1 = parity[1].slice();

    chunks.forEach((chunk, index) => {
        if (index === missingA || index === missingB) return;
        const coefficient = Utils.fecCoefficient(index);
        for (let position = 0; position < chunk.length; position++) {
            residual0[position] ^= chunk[position];
            residual1[position] ^= Utils.gfMultiply(chunk[position], coefficient);
        }
    });

    const coefficientA = Utils.fecCoefficient(missingA);
    const coefficientB = Utils.fecCoefficient(missingB);
    const denominator = coefficientA ^ coefficientB;
    const recoveredA = new Uint8Array(chunkSize);
    const recoveredB = new Uint8Array(chunkSize);
    for (let position = 0; position < chunkSize; position++) {
        const numerator = residual1[position] ^ Utils.gfMultiply(coefficientB, residual0[position]);
        recoveredA[position] = Utils.gfDivide(numerator, denominator);
        recoveredB[position] = residual0[position] ^ recoveredA[position];
    }
    return [recoveredA, recoveredB];
}

async function main() {
    const text = '日本語とASCIIの長文テスト。'.repeat(500);
    const hash = Utils.calculateHash(text);
    const transfer = await Utils.compressText(text);
    const restored = await Utils.decodeTransferBytes(transfer.bytes, transfer.encoding);
    assert.equal(restored, text, '圧縮データを元の文字列へ戻せる');

    const headerText = QRFormat.createHeader(42, Utils.getByteLength(text), hash, transfer.encoding, {
        transferSize: transfer.bytes.length,
        chunkSize: 330,
        fecGroupSize: 10,
        fecParityCount: 2
    });
    const header = QRFormat.parse(headerText);
    assert.equal(header.version, 'v2');
    assert.equal(header.totalFrames, 42);
    assert.equal(header.fecGroupSize, 10);
    assert.equal(header.fecParityCount, 2);

    const sampleBytes = new TextEncoder().encode('QRデータ');
    const sampleBase64 = Utils.bytesToBase64(sampleBytes);
    const dataText = QRFormat.createData(3, sampleBase64, Utils.calculateCRC(sampleBase64), hash);
    const data = QRFormat.parse(dataText);
    assert.equal(data.sequence, 3);
    assert.deepEqual(Utils.base64ToBytes(data.data), sampleBytes);

    const chunkSize = 330;
    const source = new Uint8Array(chunkSize * 9 + 117);
    crypto.getRandomValues(source);
    const chunks = Utils.splitBytes(source, chunkSize);
    const parity = Utils.createParityChunks(chunks, chunkSize);

    for (const [missingA, missingB] of [[0, 1], [2, 7], [8, 9]]) {
        const recovered = recoverTwo(chunks, parity, missingA, missingB, chunkSize);
        assert.deepEqual(recovered[0].slice(0, chunks[missingA].length), chunks[missingA]);
        assert.deepEqual(recovered[1].slice(0, chunks[missingB].length), chunks[missingB]);
    }

    console.log('protocol tests: ok');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
