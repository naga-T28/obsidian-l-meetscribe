import AVFoundation

/// 音声の取得元。マイクとCore Audioタップの実装は実行ファイル側にある。
public protocol CaptureSource: AnyObject {
    var track: Track { get }
    /// IOスレッドからdeliverを呼ぶ。bufferは複製済み、hostNsはバッファ先頭のホスト時刻（ナノ秒）。
    func start(deliver: @escaping (AVAudioPCMBuffer, UInt64?) -> Void) throws
    /// 資源を解放する。戻った後はdeliverを呼ばない。複数回呼んでもよい。
    func stop()
}

/// 1回の録音を管理する。開始・監視・停止はすべて`queue`上で呼ぶ。
/// 停止は一度だけ処理し、端数まで確定して通知してからstoppedを送る。
public final class RecordingController {
    public let sessionId: String
    public let queue: DispatchQueue

    private let sources: [CaptureSource]
    private let pipelines: [TrackPipeline]
    private let sink: EventSink
    private let now: () -> UInt64
    private let stallNs: UInt64
    private let onFinished: (_ exitCode: Int32) -> Void
    private var startedAtNs: UInt64?
    public private(set) var isStopped = false

    /// sourcesは開始する順に並べる。実機で安定した順序に合わせ、システム音声のタップを先に開始する。
    public init(
        sessionId: String,
        originNs: UInt64,
        chunkSeconds: Double,
        workDir: URL,
        sources: [CaptureSource],
        sink: EventSink,
        queue: DispatchQueue,
        stallSeconds: Double = 3,
        now: @escaping () -> UInt64 = HostClock.nowNanoseconds,
        onFinished: @escaping (_ exitCode: Int32) -> Void
    ) throws {
        self.sessionId = sessionId
        self.queue = queue
        self.sources = sources
        self.sink = sink
        self.now = now
        self.stallNs = UInt64(stallSeconds * 1_000_000_000)
        self.onFinished = onFinished
        let windowFrames = Timeline.windowFrames(chunkSeconds: chunkSeconds)
        let writer = try ChunkWriter(workDir: workDir, sessionId: sessionId, windowFrames: windowFrames)
        var pipelines: [TrackPipeline] = []
        var report: (HelperError) -> Void = { _ in }
        for source in sources {
            pipelines.append(TrackPipeline(
                track: source.track,
                originNs: originNs,
                windowFrames: windowFrames,
                writer: writer,
                onChunk: { sink.emit(.chunkReady($0)) },
                onFailure: { report($0) }
            ))
        }
        self.pipelines = pipelines
        report = { [weak self] error in
            guard let self else { return }
            self.queue.async { self.stop(reason: .error, error: error) }
        }
    }

    public func start() throws {
        dispatchPrecondition(condition: .onQueue(queue))
        do {
            for (source, pipeline) in zip(sources, pipelines) {
                let now = self.now
                try source.start { buffer, hostNs in
                    let receivedNs = now()
                    pipeline.queue.async { pipeline.append(buffer, hostNs: hostNs, receivedNs: receivedNs) }
                }
            }
        } catch {
            // 開始済みの取得元も含めて解放する。
            sources.forEach { $0.stop() }
            throw error
        }
        startedAtNs = now()
    }

    /// 定期的に呼ぶ。バッファが一定時間届かないトラックを、無音で埋めずに失敗として止める。
    public func checkHealth() {
        dispatchPrecondition(condition: .onQueue(queue))
        guard !isStopped, let startedAtNs else { return }
        let current = now()
        for pipeline in pipelines {
            let last = pipeline.queue.sync { pipeline.lastBufferNs } ?? startedAtNs
            if current > last, current - last > stallNs {
                stop(reason: .error, error: HelperError(
                    "trackStalled",
                    "\(pipeline.track.rawValue): no audio for \(Double(stallNs) / 1e9)s",
                    retryable: true,
                    target: pipeline.track.rawValue
                ))
                return
            }
        }
    }

    public func stop(reason: StopReason, error: HelperError? = nil) {
        dispatchPrecondition(condition: .onQueue(queue))
        guard !isStopped else { return }
        isStopped = true
        // 取得元を止めてから、キューに残ったバッファと端数を書き切る。
        sources.forEach { $0.stop() }
        var lastSequence: [Track: Int?] = [:]
        var pipelineFailure: HelperError?
        for pipeline in pipelines {
            // 停止処理中の書き込み失敗も、通知を待たずにここで拾う。
            let (sequence, failure) = pipeline.queue.sync { () -> (Int?, HelperError?) in
                pipeline.finish()
                return (pipeline.lastSequence, pipeline.firstFailure)
            }
            lastSequence[pipeline.track] = sequence
            pipelineFailure = pipelineFailure ?? failure
        }
        let failure = error ?? pipelineFailure
        if let failure {
            sink.emit(.error(failure, requestId: nil, sessionId: sessionId))
        }
        sink.emit(.stopped(sessionId: sessionId, reason: failure == nil ? reason : .error, lastSequence: lastSequence))
        onFinished(failure == nil ? 0 : 1)
    }
}
