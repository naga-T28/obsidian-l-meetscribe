import AVFoundation

/// デバイスの形式を16kHz・モノラル・16bit PCMへ変換する。
/// 最初のバッファの形式に固定し、途中で形式が変わったら変換せずに失敗させる。
public final class Resampler {
    public static let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(outputSampleRate), channels: 1, interleaved: true)!

    private let track: Track
    private var converter: AVAudioConverter?
    private var inputFormat: AVAudioFormat?

    public init(track: Track) {
        self.track = track
    }

    public func convert(_ buffer: AVAudioPCMBuffer) throws -> [Int16] {
        let format = buffer.format
        if let inputFormat {
            // 形式変更を無音や再変換で隠さず、録音を止める。
            guard inputFormat.isEqual(format) else {
                throw HelperError("formatChanged", "\(track.rawValue) stream format changed", target: track.rawValue)
            }
        } else {
            guard let converter = AVAudioConverter(from: format, to: Self.outputFormat) else {
                throw HelperError("formatUnsupported", "\(track.rawValue): cannot convert \(format)", target: track.rawValue)
            }
            converter.downmix = true
            converter.primeMethod = .none
            self.converter = converter
            inputFormat = format
        }
        var consumed = false
        return try drain { status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
    }

    /// 停止時に、変換器に残ったサンプルを出し切る。
    public func finish() throws -> [Int16] {
        guard converter != nil else { return [] }
        return try drain { status in
            status.pointee = .endOfStream
            return nil
        }
    }

    private func drain(_ input: @escaping (UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioBuffer?) throws -> [Int16] {
        guard let converter else { return [] }
        var samples: [Int16] = []
        while true {
            let capacity = AVAudioFrameCount(outputSampleRate / 2) + 64
            guard let out = AVAudioPCMBuffer(pcmFormat: Self.outputFormat, frameCapacity: capacity) else {
                throw HelperError("allocationFailed", "\(track.rawValue): output buffer", target: track.rawValue)
            }
            var error: NSError?
            let status = converter.convert(to: out, error: &error) { _, inputStatus in input(inputStatus) }
            if status == .error {
                throw HelperError("convertFailed", "\(track.rawValue): \(error?.localizedDescription ?? "unknown")", target: track.rawValue)
            }
            if out.frameLength > 0, let channel = out.int16ChannelData?[0] {
                samples.append(contentsOf: UnsafeBufferPointer(start: channel, count: Int(out.frameLength)))
            }
            // 出力が満杯なら残りがあるため続ける。それ以外は入力待ちか終端。
            if status != .haveData || out.frameLength < out.frameCapacity { return samples }
        }
    }
}

/// Core Audioが再利用する領域を、別のキューへ渡せるよう複製する。
public func copyBuffer(_ source: UnsafePointer<AudioBufferList>, format: AVAudioFormat, frames: AVAudioFrameCount) -> AVAudioPCMBuffer? {
    guard frames > 0, let copy = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return nil }
    copy.frameLength = frames
    let sourceList = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: source))
    let targetList = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
    guard sourceList.count == targetList.count else { return nil }
    for index in 0..<sourceList.count {
        guard let from = sourceList[index].mData, let to = targetList[index].mData else { return nil }
        let bytes = min(sourceList[index].mDataByteSize, targetList[index].mDataByteSize)
        memcpy(to, from, Int(bytes))
    }
    return copy
}
