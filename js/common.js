// QRコード転送システム共通処理

// v2: バイト単位の分割、圧縮、QR間の前方誤り訂正に対応
const PROTOCOL_VERSION = 'v2';

const QR_TYPE = {
    HEADER: 'HDR',
    DATA: 'DAT',
    PARITY: 'PAR'
};

const QRFormat = {
    createHeader: function(totalFrames, dataSize, dataHash, encoding = 'UTF8', options = {}) {
        const fields = [
            QR_TYPE.HEADER,
            PROTOCOL_VERSION,
            `total:${totalFrames}`,
            `size:${dataSize}`,
            `hash:${dataHash}`,
            `enc:${encoding}`
        ];

        if (options.transferSize != null) fields.push(`bytes:${options.transferSize}`);
        if (options.chunkSize != null) fields.push(`chunk:${options.chunkSize}`);
        if (options.fecGroupSize && options.fecParityCount) {
            fields.push(`fec:${options.fecGroupSize}x${options.fecParityCount}`);
        }

        return fields.join('|');
    },

    // sessionIdを指定した場合はv2形式。dataにはBase64化済みのバイト列を渡す。
    createData: function(sequence, data, crc, sessionId = null) {
        if (sessionId) {
            return `${QR_TYPE.DATA}|${PROTOCOL_VERSION}|sid:${sessionId}|seq:${sequence}|data:${data}|crc:${crc}`;
        }

        // 旧プロトコル生成との互換用
        const encodedData = btoa(unescape(encodeURIComponent(data)));
        return `${QR_TYPE.DATA}|seq:${sequence}|data:${encodedData}|crc:${crc}|b64:1`;
    },

    createParity: function(group, parityIndex, data, crc, sessionId) {
        return `${QR_TYPE.PARITY}|${PROTOCOL_VERSION}|sid:${sessionId}|grp:${group}|p:${parityIndex}|data:${data}|crc:${crc}`;
    },

    parse: function(qrData) {
        if (typeof qrData !== 'string') return null;

        const parts = qrData.split('|');
        if (parts.length < 2) return null;

        const type = parts[0];
        if (type === QR_TYPE.HEADER) {
            const result = { type, version: parts[1] };

            for (let i = 2; i < parts.length; i++) {
                const separator = parts[i].indexOf(':');
                if (separator === -1) continue;
                const key = parts[i].substring(0, separator);
                const value = parts[i].substring(separator + 1);

                if (key === 'total') result.totalFrames = Number.parseInt(value, 10);
                else if (key === 'size') result.dataSize = Number.parseInt(value, 10);
                else if (key === 'hash') result.dataHash = value;
                else if (key === 'enc') result.encoding = value;
                else if (key === 'bytes') result.transferSize = Number.parseInt(value, 10);
                else if (key === 'chunk') result.chunkSize = Number.parseInt(value, 10);
                else if (key === 'fec') {
                    const fecMatch = value.match(/^(\d+)x(\d+)$/);
                    if (fecMatch) {
                        result.fecGroupSize = Number.parseInt(fecMatch[1], 10);
                        result.fecParityCount = Number.parseInt(fecMatch[2], 10);
                    }
                }
            }

            if (!Number.isInteger(result.totalFrames) || result.totalFrames < 2 || !result.dataHash) {
                return null;
            }
            return result;
        }

        if (type !== QR_TYPE.DATA && type !== QR_TYPE.PARITY) return null;

        const isV2 = parts[1] === PROTOCOL_VERSION;
        const result = {
            type,
            version: isV2 ? parts[1] : 'v1'
        };

        const firstField = isV2 ? 2 : 1;
        for (let i = firstField; i < parts.length; i++) {
            const separator = parts[i].indexOf(':');
            if (separator === -1) continue;
            const key = parts[i].substring(0, separator);
            const value = parts[i].substring(separator + 1);

            if (key === 'sid') result.sessionId = value;
            else if (key === 'seq') result.sequence = Number.parseInt(value, 10);
            else if (key === 'grp') result.group = Number.parseInt(value, 10);
            else if (key === 'p') result.parityIndex = Number.parseInt(value, 10);
            else if (key === 'data') result.data = value;
            else if (key === 'crc') result.crc = value;
        }

        if (!isV2 && type === QR_TYPE.DATA && parts.includes('b64:1') && result.data != null) {
            try {
                result.data = Utils.base64ToUtf8(result.data);
            } catch (error) {
                console.error('Base64デコードエラー:', error);
                return null;
            }
        }

        if (result.data == null || !result.crc) return null;
        if (type === QR_TYPE.DATA && !Number.isInteger(result.sequence)) return null;
        if (type === QR_TYPE.PARITY && (!Number.isInteger(result.group) || !Number.isInteger(result.parityIndex))) {
            return null;
        }
        return result;
    }
};

// GF(256): 2枚の欠損を復元するための演算テーブル（原始多項式 0x11d）
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initializeGaloisField() {
    let value = 1;
    for (let i = 0; i < 255; i++) {
        GF_EXP[i] = value;
        GF_LOG[value] = i;
        value <<= 1;
        if (value & 0x100) value ^= 0x11d;
    }
    for (let i = 255; i < GF_EXP.length; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

const Utils = {
    calculateHash: function(data) {
        return sha256(data).substring(0, 12);
    },

    calculateCRC: function(data) {
        return CRC32.str(data).toString(16).padStart(8, '0');
    },

    getByteLength: function(str) {
        return new TextEncoder().encode(str).length;
    },

    splitBytes: function(bytes, chunkSize) {
        const chunks = [];
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            chunks.push(bytes.slice(offset, Math.min(offset + chunkSize, bytes.length)));
        }
        return chunks;
    },

    // v1互換用。文字数の決め打ちをせず、UTF-8バイト数で最大まで詰める。
    splitData: function(data, maxChunkSize = 1000) {
        const chunks = [];
        let start = 0;

        while (start < data.length) {
            let low = start + 1;
            let high = data.length;
            let best = low;
            while (low <= high) {
                const middle = Math.floor((low + high) / 2);
                if (Utils.getByteLength(data.substring(start, middle)) <= maxChunkSize) {
                    best = middle;
                    low = middle + 1;
                } else {
                    high = middle - 1;
                }
            }
            chunks.push(data.substring(start, best));
            start = best;
        }
        return chunks;
    },

    bytesToBase64: function(bytes) {
        let binary = '';
        const blockSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += blockSize) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + blockSize));
        }
        return btoa(binary);
    },

    base64ToBytes: function(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    },

    base64ToUtf8: function(base64) {
        return new TextDecoder().decode(Utils.base64ToBytes(base64));
    },

    concatenateBytes: function(chunks, totalSize = null) {
        const size = totalSize == null
            ? chunks.reduce((sum, chunk) => sum + chunk.length, 0)
            : totalSize;
        const result = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            const remaining = Math.max(0, size - offset);
            const source = chunk.subarray(0, remaining);
            result.set(source, offset);
            offset += source.length;
            if (offset >= size) break;
        }
        return result;
    },

    compressText: async function(text) {
        const rawBytes = new TextEncoder().encode(text);
        if (typeof CompressionStream === 'undefined') {
            return { bytes: rawBytes, encoding: 'UTF8' };
        }

        try {
            const stream = new CompressionStream('gzip');
            const writer = stream.writable.getWriter();
            const responsePromise = new Response(stream.readable).arrayBuffer();
            await writer.write(rawBytes);
            await writer.close();
            const compressed = new Uint8Array(await responsePromise);

            // gzipヘッダー等を含めても十分に小さくなる場合だけ採用する。
            if (compressed.length + 32 < rawBytes.length) {
                return { bytes: compressed, encoding: 'GZIP' };
            }
        } catch (error) {
            console.warn('圧縮を利用できないため非圧縮で送信します:', error);
        }

        return { bytes: rawBytes, encoding: 'UTF8' };
    },

    decodeTransferBytes: async function(bytes, encoding) {
        if (encoding !== 'GZIP') return new TextDecoder().decode(bytes);
        if (typeof DecompressionStream === 'undefined') {
            throw new Error('このブラウザは圧縮データの展開に対応していません');
        }

        const stream = new DecompressionStream('gzip');
        const writer = stream.writable.getWriter();
        const responsePromise = new Response(stream.readable).arrayBuffer();
        await writer.write(bytes);
        await writer.close();
        return new TextDecoder().decode(await responsePromise);
    },

    gfMultiply: function(a, b) {
        if (a === 0 || b === 0) return 0;
        return GF_EXP[GF_LOG[a] + GF_LOG[b]];
    },

    gfDivide: function(a, b) {
        if (b === 0) throw new Error('GF(256) division by zero');
        if (a === 0) return 0;
        let exponent = GF_LOG[a] - GF_LOG[b];
        if (exponent < 0) exponent += 255;
        return GF_EXP[exponent];
    },

    fecCoefficient: function(index) {
        return GF_EXP[index % 255];
    },

    createParityChunks: function(chunks, chunkSize) {
        const parity0 = new Uint8Array(chunkSize);
        const parity1 = new Uint8Array(chunkSize);

        chunks.forEach((chunk, index) => {
            const coefficient = Utils.fecCoefficient(index);
            for (let position = 0; position < chunk.length; position++) {
                parity0[position] ^= chunk[position];
                parity1[position] ^= Utils.gfMultiply(chunk[position], coefficient);
            }
        });
        return [parity0, parity1];
    }
};

window.QRFormat = QRFormat;
window.Utils = Utils;
window.PROTOCOL_VERSION = PROTOCOL_VERSION;
window.QR_TYPE = QR_TYPE;
