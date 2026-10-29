import AVFoundation
import Foundation
import Testing
@testable import MeetingAudioCore

/// 偽の取得元。startで受け取ったdeliverを、テストから呼んでバッファを流す。
final class FakeSource: CaptureSource, @unchecked Sendable {
    let track: Track
    var startError: HelperError?
    private(set) var startCount = 0
    private(set) var stopCount = 0
    private(set) var deliver: ((AVAudioPCMBuffer, UInt64?) -> Void)?
    private let log: CallLog

    init(track: Track, log: CallLog) {
        self.track = track
        self.log = log
    }

    func start(deliver: @escaping (AVAudioPCMBuffer, UInt64?) -> Void) throws {
        startCount += 1
        log.append("start \(track.rawValue)")
        if let startError { throw startError }
        self.deliver = deliver
    }

    func stop() {
        stopCount += 1
        log.append("stop \(track.rawValue)")
        deliver = nil
    }
}

final class CallLog: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String] = []
    func append(_ entry: String) { lock.withLock { entries.append(entry) } }
    var all: [String] { lock.withLock { entries } }
}

final class FakeClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: UInt64 = 1_000_000_000
    var now: UInt64 { lock.withLock { value } }
    func advance(seconds: Double) { lock.withLock { value += UInt64(seconds * 1e9) } }
}

@Suite struct RecordingControllerTests {
    let queue = DispatchQueue(label: "test.controller")
    let log = CallLog()
    let clock = FakeClock()
    let events = EventRecorder()
    let exitCodes = CallLog()

    private func makeController(workDir: URL, chunkSeconds: Double = 0.5) throws -> (RecordingController, FakeSource, FakeSource) {
        let other = FakeSource(track: .other, log: log)
        let mine = FakeSource(track: .selfTrack, log: log)
        let clock = self.clock
        let exitCodes = self.exitCodes
        let controller = try RecordingController(
            sessionId: "s-1",
            originNs: clock.now,
            chunkSeconds: chunkSeconds,
            workDir: workDir,
            sources: [other, mine],
            sink: events.sink,
            queue: queue,
            now: { clock.now },
            onFinished: { exitCodes.append("\($0)") }
        )
        return (controller, other, mine)
    }

    @Test("取得元を順に開始し、停止は一度だけ処理する") func case1() throws {
        let (controller, other, mine) = try makeController(workDir: try makeTempDirectory())
        try queue.sync { try controller.start() }
        #expect(log.all == ["start other", "start self"])

        other.deliver?(makeSineBuffer(seconds: 0.7), clock.now)
        mine.deliver?(makeSineBuffer(seconds: 0.7), clock.now)
        queue.sync {
            controller.stop(reason: .stopCommand)
            controller.stop(reason: .stopCommand)
            controller.stop(reason: .stdinClosed)
        }

        #expect(other.stopCount == 1)
        #expect(mine.stopCount == 1)
        #expect(exitCodes.all == ["0"])
        let types = events.types
        #expect(types.filter { $0 == "stopped" }.count == 1)
        #expect(types.last == "stopped")
        // 0.7秒を0.5秒の窓で区切り、端数まで両トラックで確定する。
        let chunks = events.events.filter { $0["type"] as? String == "chunkReady" }
        #expect(chunks.count == 4)
        let stopped = events.events.last!
        #expect(stopped["reason"] as? String == "stopCommand")
        let sequences = stopped["lastSequence"] as! [String: Any]
        #expect(sequences["self"] as? Int == 1)
        #expect(sequences["other"] as? Int == 1)
    }

    @Test("停止時に届いていたバッファを書き切ってから停止通知を送る") func case2() throws {
        let workDir = try makeTempDirectory()
        let (controller, other, mine) = try makeController(workDir: workDir, chunkSeconds: 10)
        try queue.sync { try controller.start() }
        for _ in 0..<5 {
            other.deliver?(makeSineBuffer(seconds: 0.1), clock.now)
            mine.deliver?(makeSineBuffer(seconds: 0.1), clock.now)
        }
        queue.sync { controller.stop(reason: .stdinClosed) }
        let chunks = events.events.filter { $0["type"] as? String == "chunkReady" }
        #expect(chunks.count == 2)
        for chunk in chunks {
            #expect(abs((chunk["durationMs"] as! Double) - 500) <= 2)
            #expect(FileManager.default.fileExists(atPath: workDir.appendingPathComponent(chunk["path"] as! String).path))
        }
        #expect(events.types.last == "stopped")
    }

    @Test("開始に失敗したら開始済みの取得元も解放する") func case3() throws {
        let (controller, other, mine) = try makeController(workDir: try makeTempDirectory())
        mine.startError = HelperError("startFailed", "AudioDeviceStart(input) failed")
        #expect(throws: HelperError.self) { try queue.sync { try controller.start() } }
        #expect(other.stopCount == 1)
        #expect(mine.stopCount == 1)
        #expect(events.types.isEmpty)
    }

    @Test("バッファが3秒届かないトラックで録音を止める") func case4() throws {
        let (controller, other, mine) = try makeController(workDir: try makeTempDirectory())
        try queue.sync { try controller.start() }
        other.deliver?(makeSineBuffer(seconds: 0.1), clock.now)
        mine.deliver?(makeSineBuffer(seconds: 0.1), clock.now)
        clock.advance(seconds: 2)
        other.deliver?(makeSineBuffer(seconds: 0.1), clock.now)
        clock.advance(seconds: 1.5)
        queue.sync { controller.checkHealth() }
        #expect(events.types.contains("error"))
        let error = events.events.first { $0["type"] as? String == "error" }!
        #expect(error["code"] as? String == "trackStalled")
        #expect(error["target"] as? String == "self")
        #expect(events.events.last?["reason"] as? String == "error")
        #expect(exitCodes.all == ["1"])
        #expect(other.stopCount == 1 && mine.stopCount == 1)
    }

    @Test("受信が続いていれば止めない") func case5() throws {
        let (controller, other, mine) = try makeController(workDir: try makeTempDirectory())
        try queue.sync { try controller.start() }
        for _ in 0..<5 {
            clock.advance(seconds: 1)
            other.deliver?(makeSineBuffer(seconds: 0.1), clock.now)
            mine.deliver?(makeSineBuffer(seconds: 0.1), clock.now)
            queue.sync { controller.checkHealth() }
        }
        #expect(!events.types.contains("stopped"))
        queue.sync { controller.stop(reason: .stopCommand) }
    }

    @Test("書き込みの失敗で録音を止め、エラーを通知する") func case6() async throws {
        let workDir = try makeTempDirectory()
        let (controller, other, mine) = try makeController(workDir: workDir, chunkSeconds: 0.1)
        try queue.sync { try controller.start() }
        let chunks = workDir.appendingPathComponent("chunks").path
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: chunks)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: chunks) }
        other.deliver?(makeSineBuffer(seconds: 0.3), clock.now)
        mine.deliver?(makeSineBuffer(seconds: 0.3), clock.now)
        for _ in 0..<200 where !events.types.contains("stopped") {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        let error = events.events.first { $0["type"] as? String == "error" }
        #expect(error?["code"] as? String == "writeFailed")
        #expect(events.types.filter { $0 == "stopped" }.count == 1)
        #expect(exitCodes.all == ["1"])
        #expect(other.stopCount == 1 && mine.stopCount == 1)
    }

    @Test("停止処理中の書き込み失敗もエラーとして通知する") func case7() throws {
        let workDir = try makeTempDirectory()
        let (controller, other, mine) = try makeController(workDir: workDir, chunkSeconds: 10)
        try queue.sync { try controller.start() }
        other.deliver?(makeSineBuffer(seconds: 0.2), clock.now)
        mine.deliver?(makeSineBuffer(seconds: 0.2), clock.now)
        let chunks = workDir.appendingPathComponent("chunks").path
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: chunks)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: chunks) }
        queue.sync { controller.stop(reason: .stopCommand) }
        #expect(events.types.contains("error"))
        #expect(events.events.last?["reason"] as? String == "error")
        #expect(exitCodes.all == ["1"])
    }
}
