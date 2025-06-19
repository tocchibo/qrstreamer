// QRコード転送システム共通処理

// プロトコルバージョン
const PROTOCOL_VERSION = 'v1';

// QRコードタイプ
const QR_TYPE = {
    HEADER: 'HDR',
    DATA: 'DAT'
};

// QRコードフォーマット関連
const QRFormat = {
    // ヘッダーQRコード生成
    createHeader: function(totalFrames, dataSize, dataHash, encoding = 'UTF8') {
        return `${QR_TYPE.HEADER}|${PROTOCOL_VERSION}|total:${totalFrames}|size:${dataSize}|hash:${dataHash}|enc:${encoding}`;
    },

    // データQRコード生成
    createData: function(sequence, data, crc) {
        return `${QR_TYPE.DATA}|seq:${sequence}|data:${data}|crc:${crc}`;
    },

    // QRコードパース
    parse: function(qrData) {
        const parts = qrData.split('|');
        if (parts.length < 2) {
            return null;
        }

        const type = parts[0];
        
        if (type === QR_TYPE.HEADER) {
            if (parts.length !== 6) return null;
            
            const result = {
                type: type,
                version: parts[1]
            };

            // パラメータを解析
            for (let i = 2; i < parts.length; i++) {
                const [key, value] = parts[i].split(':');
                if (key === 'total') result.totalFrames = parseInt(value);
                else if (key === 'size') result.dataSize = parseInt(value);
                else if (key === 'hash') result.dataHash = value;
                else if (key === 'enc') result.encoding = value;
            }

            return result;
        } else if (type === QR_TYPE.DATA) {
            if (parts.length !== 4) return null;

            const result = {
                type: type
            };

            // seq:X を解析
            const seqPart = parts[1].split(':');
            if (seqPart[0] === 'seq') {
                result.sequence = parseInt(seqPart[1]);
            }

            // data:XXX を解析（データ部分は':'を含む可能性があるため特別処理）
            const dataPrefix = 'data:';
            const dataStartIndex = qrData.indexOf(dataPrefix, parts[0].length + parts[1].length);
            if (dataStartIndex !== -1) {
                const dataStart = dataStartIndex + dataPrefix.length;
                const lastPipe = qrData.lastIndexOf('|');
                result.data = qrData.substring(dataStart, lastPipe);
            }

            // crc:XXX を解析
            const crcPart = parts[parts.length - 1].split(':');
            if (crcPart[0] === 'crc') {
                result.crc = crcPart[1];
            }

            return result;
        }

        return null;
    }
};

// ユーティリティ関数
const Utils = {
    // SHA-256ハッシュ計算（先頭12文字を返す）
    calculateHash: function(data) {
        const hash = sha256(data);
        return hash.substring(0, 12);
    },

    // CRC32計算
    calculateCRC: function(data) {
        return CRC32.str(data).toString(16).padStart(8, '0');
    },

    // UTF-8バイト数計算
    getByteLength: function(str) {
        return new TextEncoder().encode(str).length;
    },

    // データ分割（最大サイズを考慮）
    splitData: function(data, maxChunkSize = 1000) {
        const chunks = [];
        let index = 0;
        
        while (index < data.length) {
            // 次のチャンクの終了位置を計算
            let endIndex = Math.min(index + maxChunkSize, data.length);
            
            // UTF-8の境界を考慮して調整
            while (endIndex > index) {
                const chunk = data.substring(index, endIndex);
                const byteLength = Utils.getByteLength(chunk);
                
                if (byteLength <= maxChunkSize) {
                    chunks.push(chunk);
                    index = endIndex;
                    break;
                } else {
                    // バイト数が多すぎる場合は文字数を減らす
                    endIndex--;
                }
            }
        }
        
        return chunks;
    },

    // QRコード容量計算（エラー訂正レベルM）
    getQRCapacity: function(version = 10) {
        // 簡易的な容量計算（実際の容量はより複雑）
        // バージョン10でエラー訂正レベルMの場合、約1,000バイト
        return 1000;
    }
};

// エクスポート（グローバル変数として）
window.QRFormat = QRFormat;
window.Utils = Utils;
window.PROTOCOL_VERSION = PROTOCOL_VERSION;
window.QR_TYPE = QR_TYPE;