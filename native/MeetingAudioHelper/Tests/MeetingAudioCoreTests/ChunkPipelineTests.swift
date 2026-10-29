import AVFoundation
import Foundation
import Testing
@testable import MeetingAudioCore

@Suite struct ChunkWriterTests {
    @Test("WAVとメタ情報を確定名で書き、一時ファイルを残さない") func case1() throws {
        let workDir = try makeTempDirectory()
        let writer = try ChunkWriter(workDir: workDir, sessionId: "s-1", windowFrames: 160_000)
        let notice = try writer.write(track: .other, chunk: ChunkedAudio(sequence: 2, samples: [1, 2, 3, 4]))

        #expect(notice == ChunkNotice(sessionId: "s-1", track: .other, sequence: 2, startMs: 20_000, durationMs: 0.25, path: "chunks/other-000002.wav", rmsDbfs: WAV.rmsDbfs([1, 2, 3, 4])))
        let chunks = workDir.appendingPathComponent("chunks")
        #expect(try FileManager.default.contentsOfDirectory(atPath: chunks.path).sorted() == ["other-000002.json", "other-000002.wav"])
        #expect(try readWAVSamples(workDir.appendingPathComponent(notice.path)) == [1, 2, 3, 4])
        let metadata = try JSONSerialization.jsonObject(with: Data(contentsOf: chunks.appendingPathComponent("other-000002.json"))) as! [String: Any]
        #expect(metadata["track"] as? String == "other")
        #expect(metadata["sequence"] as? Int == 2)
        #expect(metadata["startMs"] as? Double == 20_000)
    }

    @Test("同じ番号のチャンクを上書きしない") func case2() throws {
        let writer = try ChunkWriter(workDir: try makeTempDirectory(), sessionId: "s-1", windowFrames: 4)
        _ = try writer.write(track: .selfTrack, chunk: ChunkedAudio(sequence: 0, samples: [1]))
        #expect(throws: HelperError.self) {
            try writer.write(track: .selfTrack, chunk: ChunkedAudio(sequence: 0, samples: [2]))
        }
    }

    @Test("作業領域がない場合と既にchunksがある場合は開始しない") func case3() throws {
        let missing = FileManager.default.temporaryDirectory.appendingPathComponent("lms-missing-\(UUID().uuidString)")
        #expect(throws: HelperError.self) { try ChunkWriter(workDir: missing, sessionId: "s-1", windowFrames: 4) }

        let workDir = try makeTempDirectory()
        _ = try ChunkWriter(workDir: workDir, sessionId: "s-1", windowFrames: 4)
        #expect(throws: HelperError.self) { try ChunkWriter(workDir: workDir, sessionId: "s-1", windowFrames: 4) }
    }

    @Test("書き込みに失敗したらwriteFailedを投げる") func case4() throws {
        let workDir = try makeTempDirectory()
        let writer = try ChunkWriter(workDir: workDir, sessionId: "s-1", windowFrames: 4)
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: workDir.appendingPathComponent("chunks").path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: workDir.appendingPathComponent("chunks").path) }
        do {
            _ = try writer.write(track: .selfTrack, chunk: ChunkedAudio(sequence: 0, samples: [1]))
            Issue.record("write should fail")
        } catch let error as HelperError {
            #expect(error.code == "writeFailed")
        }
    }
}

@Suite struct ResamplerTests {
    @Test("四十八kHzステレオを16kHzモノラルへ変換する") func case5() throws {
        let resampler = Resampler(track: .other)
        var samples = try resampler.convert(makeSineBuffer(seconds: 1))
        samples += try resampler.finish()
        #expect(abs(samples.count - 16_000) <= 32)
        // 振幅0.5の正弦波はRMSが約-9dBFS。
        #expect(abs(WAV.rmsDbfs(Array(samples[1_000..<15_000])) - (-9.03)) < 0.5)
    }

    @Test("途中で形式が変わったら変換しない") func case6() throws {
        let resampler = Resampler(track: .selfTrack)
        _ = try resampler.convert(makeSineBuffer(seconds: 0.1))
        do {
            _ = try resampler.convert(makeSineBuffer(seconds: 0.1, sampleRate: 44_100))
            Issue.record("convert should fail")
        } catch let error as HelperError {
            #expect(error.code == "formatChanged")
            #expect(error.target == "self")
        }
    }
}

@Suite struct TrackPipelineTests {
    private struct Run {
        var notices: [ChunkNotice] = []
        var failures: [HelperError] = []
    }

    private final class Box: @unchecked Sendable {
        var run = Run()
    }

    private func makePipeline(workDir: URL, windowFrames: Int, originNs: UInt64 = 1_000_000_000) throws -> (TrackPipeline, Box) {
        let box = Box()
        let writer = try ChunkWriter(workDir: workDir, sessionId: "s-1", windowFrames: windowFrames)
        let pipeline = TrackPipeline(
            track: .selfTrack,
            originNs: originNs,
            windowFrames: windowFrames,
            writer: writer,
            onChunk: { box.run.notices.append($0) },
            onFailure: { box.run.failures.append($0) }
        )
        return (pipeline, box)
    }

    @Test("最初のバッファの時刻まで無音で埋め、共通の時間窓で区切る") func case7() throws {
        let workDir = try makeTempDirectory()
        let (pipeline, box) = try makePipeline(workDir: workDir, windowFrames: 8_000)
        pipeline.queue.sync {
            // 録音開始から250ms後に最初のバッファが届いた。
            pipeline.append(makeSineBuffer(seconds: 1), hostNs: 1_250_000_000, receivedNs: 0)
            pipeline.finish()
        }
        let notices = box.run.notices
        #expect(box.run.failures.isEmpty)
        #expect(notices.map(\.sequence) == [0, 1, 2])
        #expect(notices.map(\.startMs) == [0, 500, 1_000])
        #expect(notices[0].durationMs == 500)
        // 合計は250ms＋1秒。変換の端数を許容する。
        let total = notices.reduce(0) { $0 + $1.durationMs }
        #expect(abs(total - 1_250) <= 2)
        let first = try readWAVSamples(workDir.appendingPathComponent(notices[0].path))
        #expect(first[0..<4_000].allSatisfy { $0 == 0 })
        #expect(first[4_100..<8_000].contains { $0 != 0 })
        #expect(pipeline.queue.sync { pipeline.lastSequence } == 2)
    }

    @Test("開始より前の時刻のサンプルを切り捨てる") func case8() throws {
        let workDir = try makeTempDirectory()
        let (pipeline, box) = try makePipeline(workDir: workDir, windowFrames: 160_000)
        pipeline.queue.sync {
            pipeline.append(makeSineBuffer(seconds: 0.1), hostNs: 1_000_000_000 - 50_000_000, receivedNs: 0)
            pipeline.append(makeSineBuffer(seconds: 0.1), hostNs: nil, receivedNs: 0)
            pipeline.finish()
        }
        let total = box.run.notices.reduce(0) { $0 + $1.durationMs }
        #expect(abs(total - 150) <= 2)
    }

    @Test("最初のバッファにホスト時刻がなければ失敗にする") func case9() throws {
        let (pipeline, box) = try makePipeline(workDir: try makeTempDirectory(), windowFrames: 160_000)
        pipeline.queue.sync {
            pipeline.append(makeSineBuffer(seconds: 0.1), hostNs: nil, receivedNs: 0)
            pipeline.append(makeSineBuffer(seconds: 0.1), hostNs: 1_000_000_000, receivedNs: 0)
            pipeline.finish()
        }
        #expect(box.run.failures.map(\.code) == ["hostTimeInvalid"])
        #expect(box.run.notices.isEmpty)
        #expect(pipeline.queue.sync { pipeline.firstFailure?.code } == "hostTimeInvalid")
    }

    @Test("形式変更の後は書き込まず端数も確定しない") func case10() throws {
        let (pipeline, box) = try makePipeline(workDir: try makeTempDirectory(), windowFrames: 160_000)
        pipeline.queue.sync {
            pipeline.append(makeSineBuffer(seconds: 0.1), hostNs: 1_000_000_000, receivedNs: 0)
            pipeline.append(makeSineBuffer(seconds: 0.1, channels: 1), hostNs: 1_100_000_000, receivedNs: 0)
            pipeline.finish()
        }
        #expect(box.run.failures.map(\.code) == ["formatChanged"])
        #expect(box.run.notices.isEmpty)
    }
}
