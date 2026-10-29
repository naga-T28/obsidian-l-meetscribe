/// 時間窓に区切ったチャンク。番号は時間窓の番号で、両トラックで同じ番号は同じ時間帯を表す。
public struct ChunkedAudio: Equatable, Sendable {
    public var sequence: Int
    public var samples: [Int16]
}

/// 1トラック分の16kHzサンプルを共通の時間窓で区切る。
/// 先頭のサンプルは録音開始時刻に置かれている前提で、i番目の窓は[i×窓長, (i+1)×窓長)を表す。
public struct TrackChunker {
    public let windowFrames: Int
    public private(set) var lastSequence: Int?
    private var nextSequence = 0
    private var pending: [Int16] = []

    public init(windowFrames: Int) {
        precondition(windowFrames > 0)
        self.windowFrames = windowFrames
        pending.reserveCapacity(windowFrames)
    }

    /// 窓が埋まった分のチャンクを返す。
    public mutating func append(_ samples: [Int16]) -> [ChunkedAudio] {
        var completed: [ChunkedAudio] = []
        var index = samples.startIndex
        while index < samples.endIndex {
            let take = min(windowFrames - pending.count, samples.endIndex - index)
            pending.append(contentsOf: samples[index..<(index + take)])
            index += take
            if pending.count == windowFrames {
                completed.append(emit())
            }
        }
        return completed
    }

    /// 停止時に端数を確定する。端数がなければnil。
    public mutating func finish() -> ChunkedAudio? {
        pending.isEmpty ? nil : emit()
    }

    private mutating func emit() -> ChunkedAudio {
        let chunk = ChunkedAudio(sequence: nextSequence, samples: pending)
        lastSequence = nextSequence
        nextSequence += 1
        pending = []
        pending.reserveCapacity(windowFrames)
        return chunk
    }
}
