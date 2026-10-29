import Foundation

/// 16bit・モノラルのPCM WAV。チャンクは数百KBのため、メモリ上で組み立ててから書く。
public enum WAV {
    public static func encode(samples: [Int16], sampleRate: Int = outputSampleRate) -> Data {
        let dataBytes = UInt32(samples.count * 2)
        var data = Data(capacity: 44 + Int(dataBytes))
        data.append(contentsOf: Array("RIFF".utf8))
        data.appendLittleEndian(UInt32(36) + dataBytes)
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8))
        data.appendLittleEndian(UInt32(16))
        data.appendLittleEndian(UInt16(1)) // PCM
        data.appendLittleEndian(UInt16(1)) // モノラル
        data.appendLittleEndian(UInt32(sampleRate))
        data.appendLittleEndian(UInt32(sampleRate * 2)) // バイト/秒
        data.appendLittleEndian(UInt16(2)) // ブロックサイズ
        data.appendLittleEndian(UInt16(16)) // ビット深度
        data.append(contentsOf: Array("data".utf8))
        data.appendLittleEndian(dataBytes)
        for sample in samples {
            data.appendLittleEndian(UInt16(bitPattern: sample))
        }
        return data
    }

    /// 無音（全サンプル0）でも数値で扱えるよう、下限を-120dBFSにする。
    public static let silenceFloorDbfs = -120.0

    public static func rmsDbfs(_ samples: [Int16]) -> Double {
        guard !samples.isEmpty else { return silenceFloorDbfs }
        var sumSquares = 0.0
        for sample in samples {
            let value = Double(sample)
            sumSquares += value * value
        }
        let rms = (sumSquares / Double(samples.count)).squareRoot() / 32_768
        guard rms > 0 else { return silenceFloorDbfs }
        return max(silenceFloorDbfs, 20 * log10(rms))
    }
}

private extension Data {
    mutating func appendLittleEndian<T: FixedWidthInteger>(_ value: T) {
        Swift.withUnsafeBytes(of: value.littleEndian) { append(contentsOf: $0) }
    }
}
