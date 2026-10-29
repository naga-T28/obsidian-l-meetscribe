import AVFoundation
import Foundation
@testable import MeetingAudioCore

/// テストごとの一時フォルダ。音声は合成データだけを使う。
func makeTempDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("lms-helper-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

/// 48kHz・ステレオ・Float32の正弦波。デバイスから届く典型的な形式。
func makeSineBuffer(seconds: Double, sampleRate: Double = 48_000, channels: AVAudioChannelCount = 2, amplitude: Float = 0.5) -> AVAudioPCMBuffer {
    let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: channels)!
    let frames = AVAudioFrameCount(seconds * sampleRate)
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
    buffer.frameLength = frames
    for channel in 0..<Int(channels) {
        let data = buffer.floatChannelData![channel]
        for frame in 0..<Int(frames) {
            data[frame] = amplitude * sin(2 * .pi * 440 * Float(frame) / Float(sampleRate))
        }
    }
    return buffer
}

/// 出力されたイベントを記録する。
final class EventRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [Data] = []

    lazy var sink = EventSink { [weak self] data in
        guard let self else { return }
        self.lock.withLock { self.lines.append(data) }
    }

    var events: [[String: Any]] {
        lock.withLock { lines }.map { try! JSONSerialization.jsonObject(with: $0) as! [String: Any] }
    }

    var types: [String] { events.map { $0["type"] as! String } }
}

func readWAVSamples(_ url: URL) throws -> [Int16] {
    let data = try Data(contentsOf: url)
    return stride(from: 44, to: data.count, by: 2).map { offset in
        Int16(bitPattern: UInt16(data[offset]) | UInt16(data[offset + 1]) << 8)
    }
}
