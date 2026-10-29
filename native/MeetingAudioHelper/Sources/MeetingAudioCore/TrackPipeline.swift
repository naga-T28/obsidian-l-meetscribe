import AVFoundation

/// 1トラック分の受信バッファを、変換・時刻合わせ・時間窓での区切り・書き込み・通知まで処理する。
/// すべての処理を`queue`上で行う。
public final class TrackPipeline {
    public let track: Track
    public let queue: DispatchQueue

    private let originNs: UInt64
    private let resampler: Resampler
    private var chunker: TrackChunker
    private let writer: ChunkWriter
    private let onChunk: (ChunkNotice) -> Void
    private let onFailure: (HelperError) -> Void
    private var started = false
    /// 録音開始より前の時刻を持つサンプルの残り。最初のバッファで決まる。
    private var framesToTrim = 0
    private var failure: HelperError?
    private var lastReceivedNs: UInt64?

    /// originNsは録音開始のホスト時刻（ナノ秒）。両トラックで同じ値を使う。
    public init(
        track: Track,
        originNs: UInt64,
        windowFrames: Int,
        writer: ChunkWriter,
        onChunk: @escaping (ChunkNotice) -> Void,
        onFailure: @escaping (HelperError) -> Void
    ) {
        self.track = track
        self.originNs = originNs
        self.writer = writer
        self.onChunk = onChunk
        self.onFailure = onFailure
        resampler = Resampler(track: track)
        chunker = TrackChunker(windowFrames: windowFrames)
        queue = DispatchQueue(label: "lms.helper.pipeline.\(track.rawValue)")
    }

    /// queue上で呼ぶ。最後にバッファを受け取ったホスト時刻（ナノ秒）。
    public var lastBufferNs: UInt64? { lastReceivedNs }

    /// queue上で呼ぶ。最後に通知したチャンクの番号。
    public var lastSequence: Int? { chunker.lastSequence }

    /// queue上で呼ぶ。最初に起きた失敗。失敗後は処理を続けない。
    public var firstFailure: HelperError? { failure }

    /// queue上で呼ぶ。bufferは呼び出し元が複製済みであること。hostNsはバッファ先頭のホスト時刻。
    public func append(_ buffer: AVAudioPCMBuffer, hostNs: UInt64?, receivedNs: UInt64) {
        guard failure == nil else { return }
        lastReceivedNs = receivedNs
        do {
            var samples = try resampler.convert(buffer)
            if !started {
                samples = try align(samples, firstHostNs: hostNs)
                started = true
            } else if framesToTrim > 0 {
                samples = trim(samples)
            }
            try write(chunker.append(samples))
        } catch {
            fail(error)
        }
    }

    /// queue上で呼ぶ。変換器の残りと端数のチャンクを確定する。失敗後は何もしない。
    public func finish() {
        guard failure == nil else { return }
        do {
            try write(chunker.append(trim(resampler.finish())))
            if let last = chunker.finish() {
                try write([last])
            }
        } catch {
            fail(error)
        }
    }

    /// 両トラックの開始位置を、最初のバッファのホスト時刻でそろえる。トラックごとに開始の遅れが違っても、同じ時刻が同じ位置に来るようにするため。
    /// 録音開始から最初のバッファまでは、デバイスがまだ音を取っていない区間なので無音で埋める。
    private func align(_ samples: [Int16], firstHostNs: UInt64?) throws -> [Int16] {
        guard let firstHostNs else {
            throw HelperError("hostTimeInvalid", "\(track.rawValue): first buffer has no host time", target: track.rawValue)
        }
        let offsetFrames = Timeline.frames(fromNanoseconds: Int64(bitPattern: firstHostNs &- originNs))
        if offsetFrames >= 0 {
            return [Int16](repeating: 0, count: Int(offsetFrames)) + samples
        }
        framesToTrim = Int(-offsetFrames)
        return trim(samples)
    }

    private func trim(_ samples: [Int16]) -> [Int16] {
        let count = min(framesToTrim, samples.count)
        framesToTrim -= count
        return Array(samples.dropFirst(count))
    }

    private func write(_ chunks: [ChunkedAudio]) throws {
        for chunk in chunks {
            onChunk(try writer.write(track: track, chunk: chunk))
        }
    }

    private func fail(_ error: Error) {
        let helperError = error as? HelperError ?? HelperError("writeFailed", "\(track.rawValue): \(error)", target: track.rawValue)
        failure = helperError
        onFailure(helperError)
    }
}
