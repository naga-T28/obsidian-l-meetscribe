import Darwin
import Foundation
import Testing
@testable import MeetingAudioCore

@Suite struct WAVTests {
    private func uint32(_ data: Data, _ offset: Int) -> UInt32 {
        (0..<4).reduce(0) { $0 | UInt32(data[offset + $1]) << (8 * $1) }
    }

    private func uint16(_ data: Data, _ offset: Int) -> UInt16 {
        UInt16(data[offset]) | UInt16(data[offset + 1]) << 8
    }

    @Test("十六kHzモノラル16bitPCMのヘッダーを書く") func case1() {
        let data = WAV.encode(samples: [0, 1, -1, Int16.max, Int16.min])
        #expect(data.count == 44 + 10)
        #expect(String(decoding: data[0..<4], as: UTF8.self) == "RIFF")
        #expect(uint32(data, 4) == 36 + 10)
        #expect(String(decoding: data[8..<16], as: UTF8.self) == "WAVEfmt ")
        #expect(uint32(data, 16) == 16)
        #expect(uint16(data, 20) == 1) // PCM
        #expect(uint16(data, 22) == 1) // モノラル
        #expect(uint32(data, 24) == 16_000)
        #expect(uint32(data, 28) == 32_000)
        #expect(uint16(data, 32) == 2)
        #expect(uint16(data, 34) == 16)
        #expect(String(decoding: data[36..<40], as: UTF8.self) == "data")
        #expect(uint32(data, 40) == 10)
    }

    @Test("サンプルをリトルエンディアンで書く") func case2() throws {
        let url = try makeTempDirectory().appendingPathComponent("a.wav")
        let samples: [Int16] = [0, 1, -1, 300, Int16.max, Int16.min]
        try WAV.encode(samples: samples).write(to: url)
        #expect(try readWAVSamples(url) == samples)
    }

    @Test("空のWAVを書ける") func case3() {
        let data = WAV.encode(samples: [])
        #expect(data.count == 44)
        #expect(uint32(data, 40) == 0)
    }

    @Test("RMSをdBFSで返す") func case4() {
        #expect(WAV.rmsDbfs([]) == WAV.silenceFloorDbfs)
        #expect(WAV.rmsDbfs([0, 0, 0]) == WAV.silenceFloorDbfs)
        let full = WAV.rmsDbfs([Int16.min, Int16.min])
        #expect(abs(full) < 0.001)
        let half = WAV.rmsDbfs([16_384, -16_384])
        #expect(abs(half - (-6.0206)) < 0.001)
        // 極小の値でも下限を下回らない。
        #expect(WAV.rmsDbfs([1] + [Int16](repeating: 0, count: 1_000_000)) == WAV.silenceFloorDbfs)
    }
}

@Suite struct TimelineTests {
    @Test("ナノ秒を16kHzのサンプル数へ換算する") func case5() {
        #expect(Timeline.frames(fromNanoseconds: 1_000_000_000) == 16_000)
        #expect(Timeline.frames(fromNanoseconds: 62_500) == 1)
        #expect(Timeline.frames(fromNanoseconds: 31_250) == 1) // 0.5サンプルは四捨五入
        #expect(Timeline.frames(fromNanoseconds: 31_249) == 0)
        #expect(Timeline.frames(fromNanoseconds: -250_000_000) == -4_000)
        #expect(Timeline.frames(fromNanoseconds: 3_600 * 1_000_000_000) == 57_600_000)
    }

    @Test("サンプル数をミリ秒へ換算する") func case6() {
        #expect(Timeline.milliseconds(frames: 16_000) == 1_000)
        #expect(Timeline.milliseconds(frames: 1) == 0.0625)
        #expect(Timeline.milliseconds(frames: 160_000 * 360) == 3_600_000)
    }

    @Test("窓長をサンプル数で返す") func case7() {
        #expect(Timeline.windowFrames(chunkSeconds: 10) == 160_000)
        #expect(Timeline.windowFrames(chunkSeconds: 0.1) == 1_600)
    }

    @Test("ホスト時刻の換算は長時間の稼働でも桁あふれしない") func case8() {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        // 起動から約1年分のホスト時刻。
        let ticks = UInt64(365 * 24 * 3_600) * 1_000_000_000 / UInt64(info.numer) * UInt64(info.denom)
        let expected = Double(ticks) * Double(info.numer) / Double(info.denom)
        #expect(abs(Double(HostClock.nanoseconds(fromTicks: ticks)) - expected) < 1_000)
        let a = HostClock.nowNanoseconds()
        let b = HostClock.nowNanoseconds()
        #expect(b >= a)
    }
}

@Suite struct TrackChunkerTests {
    @Test("窓が埋まるたびに番号順で確定する") func case9() {
        var chunker = TrackChunker(windowFrames: 4)
        #expect(chunker.append([1, 2, 3]).isEmpty)
        let first = chunker.append([4, 5, 6, 7, 8, 9, 10])
        #expect(first == [ChunkedAudio(sequence: 0, samples: [1, 2, 3, 4]), ChunkedAudio(sequence: 1, samples: [5, 6, 7, 8])])
        #expect(chunker.lastSequence == 1)
        #expect(chunker.finish() == ChunkedAudio(sequence: 2, samples: [9, 10]))
        #expect(chunker.lastSequence == 2)
        #expect(chunker.finish() == nil)
    }

    @Test("端数がなければ停止時に空のチャンクを作らない") func case10() {
        var chunker = TrackChunker(windowFrames: 2)
        #expect(chunker.append([1, 2]).count == 1)
        #expect(chunker.finish() == nil)
        #expect(chunker.lastSequence == 0)
    }

    @Test("何も受け取らなければ番号を持たない") func case11() {
        var chunker = TrackChunker(windowFrames: 2)
        #expect(chunker.finish() == nil)
        #expect(chunker.lastSequence == nil)
    }

    @Test("一度に複数の窓を超える入力も分割する") func case12() {
        var chunker = TrackChunker(windowFrames: 3)
        let chunks = chunker.append(Array(0..<10).map(Int16.init))
        #expect(chunks.map(\.sequence) == [0, 1, 2])
        #expect(chunks.allSatisfy { $0.samples.count == 3 })
        #expect(chunker.finish()?.samples == [9])
    }
}
