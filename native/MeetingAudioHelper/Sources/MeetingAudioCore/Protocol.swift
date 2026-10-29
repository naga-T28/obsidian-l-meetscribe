import Foundation

// プラグインとの標準入出力のJSON Lines。1行に1メッセージを置き、`type`で種類を表す。
// プラグイン側の実装は src/audio/protocol.ts にある。両方を同時に変更する。

public let helperProtocolVersion = 1

/// プラグインはこの間隔より短い周期でheartbeatを送る。途絶えたら録音を止める。
public let heartbeatTimeoutSeconds: Double = 15

public enum Track: String, CaseIterable, Sendable {
    case selfTrack = "self"
    case other
}

public struct StartParameters: Equatable, Sendable {
    public var requestId: String
    public var sessionId: String
    /// nilなら録音開始時のシステム既定入力。
    public var inputUid: String?
    /// nilならすべての出力。
    public var outputUid: String?
    public var chunkSeconds: Double
    /// セッションの作業領域。チャンクはこの配下の`chunks/`にだけ書く。
    public var workDir: String
}

public enum HelperCommand: Equatable, Sendable {
    case hello(requestId: String, protocolVersion: Int)
    case listDevices(requestId: String)
    case start(StartParameters)
    case stop(sessionId: String)
    case heartbeat(sessionId: String)
}

public struct HelperError: Error, Equatable, Sendable, CustomStringConvertible {
    public var code: String
    public var message: String
    /// 同じ操作をやり直して成功する見込みがあるか。
    public var retryable: Bool
    /// 対象のトラックやデバイスなど。
    public var target: String?

    public init(_ code: String, _ message: String, retryable: Bool = false, target: String? = nil) {
        self.code = code
        self.message = message
        self.retryable = retryable
        self.target = target
    }

    public var description: String { "\(code): \(message)" }
}

public enum StopReason: String, Sendable {
    case stopCommand
    case stdinClosed
    case heartbeatTimeout
    case signal
    case error
}

public struct DeviceInfo: Equatable, Sendable {
    public var uid: String
    public var name: String
    public var inputChannels: Int
    public var outputChannels: Int
    public var nominalSampleRate: Double

    public init(uid: String, name: String, inputChannels: Int, outputChannels: Int, nominalSampleRate: Double) {
        self.uid = uid
        self.name = name
        self.inputChannels = inputChannels
        self.outputChannels = outputChannels
        self.nominalSampleRate = nominalSampleRate
    }
}

public struct ChunkNotice: Equatable, Sendable {
    public var sessionId: String
    public var track: Track
    public var sequence: Int
    /// 録音開始（startコマンドの受付時刻）からのミリ秒。
    public var startMs: Double
    public var durationMs: Double
    /// 作業領域からの相対パス。
    public var path: String
    public var rmsDbfs: Double
}

public enum HelperEvent: Sendable {
    case ready(requestId: String, helperVersion: String)
    case devices(requestId: String, inputs: [DeviceInfo], outputs: [DeviceInfo], defaultInputUid: String?, defaultOutputUid: String?)
    case started(requestId: String, sessionId: String, inputUid: String, outputTarget: String)
    case chunkReady(ChunkNotice)
    /// 各トラックで最後に通知したチャンクの番号。1つも通知していなければnil。
    case stopped(sessionId: String, reason: StopReason, lastSequence: [Track: Int?])
    case error(HelperError, requestId: String?, sessionId: String?)
}

// MARK: - 受信

public func parseCommand(_ line: String) throws -> HelperCommand {
    guard let data = line.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data),
          let fields = object as? [String: Any]
    else {
        throw HelperError("badMessage", "message is not a JSON object")
    }
    let message = Fields(fields)
    switch try message.string("type") {
    case "hello":
        return .hello(requestId: try message.requestId(), protocolVersion: try message.integer("protocolVersion"))
    case "listDevices":
        return .listDevices(requestId: try message.requestId())
    case "start":
        let chunkSeconds = try message.number("chunkSeconds")
        guard (0.1...600).contains(chunkSeconds) else {
            throw HelperError("badMessage", "chunkSeconds must be between 0.1 and 600")
        }
        let workDir = try message.string("workDir")
        // 作業先の外へ書かないよう、正規化しても変わらない絶対パスだけを受け付ける。
        guard workDir.hasPrefix("/"), (workDir as NSString).standardizingPath == workDir else {
            throw HelperError("badMessage", "workDir must be a normalized absolute path")
        }
        return .start(StartParameters(
            requestId: try message.requestId(),
            sessionId: try message.sessionId(),
            inputUid: try message.optionalString("inputUid"),
            outputUid: try message.optionalString("outputUid"),
            chunkSeconds: chunkSeconds,
            workDir: workDir
        ))
    case "stop":
        return .stop(sessionId: try message.sessionId())
    case "heartbeat":
        return .heartbeat(sessionId: try message.sessionId())
    case let other:
        throw HelperError("badMessage", "unknown message type: \(other)")
    }
}

/// セッションIDはパスの一部になるため、英数字とハイフンに限る。
public func isValidSessionId(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 128 && value.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
}

private struct Fields {
    let values: [String: Any]
    init(_ values: [String: Any]) { self.values = values }

    func string(_ key: String) throws -> String {
        guard let value = values[key] as? String, !value.isEmpty else {
            throw HelperError("badMessage", "\(key) must be a non-empty string")
        }
        return value
    }

    func optionalString(_ key: String) throws -> String? {
        if values[key] == nil || values[key] is NSNull { return nil }
        return try string(key)
    }

    func number(_ key: String) throws -> Double {
        // JSONSerializationは真偽値もNSNumberで返すため、明示的に除く。
        guard let value = values[key] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else {
            throw HelperError("badMessage", "\(key) must be a number")
        }
        return value.doubleValue
    }

    func integer(_ key: String) throws -> Int {
        let value = try number(key)
        guard value.rounded() == value, abs(value) < 1e9 else {
            throw HelperError("badMessage", "\(key) must be an integer")
        }
        return Int(value)
    }

    func requestId() throws -> String {
        let value = try string("requestId")
        guard value.utf8.count <= 128 else { throw HelperError("badMessage", "requestId is too long") }
        return value
    }

    func sessionId() throws -> String {
        let value = try string("sessionId")
        guard isValidSessionId(value) else { throw HelperError("badMessage", "sessionId has an invalid format") }
        return value
    }
}

// MARK: - 送信

public func encodeEvent(_ event: HelperEvent) -> Data {
    var data = (try? JSONSerialization.data(withJSONObject: jsonObject(event), options: [.sortedKeys])) ?? Data()
    data.append(0x0A)
    return data
}

func jsonObject(_ event: HelperEvent) -> [String: Any] {
    switch event {
    case let .ready(requestId, helperVersion):
        return [
            "type": "ready",
            "requestId": requestId,
            "protocolVersion": helperProtocolVersion,
            "helperVersion": helperVersion,
            "capabilities": ["chunkReady", "listDevices", "outputTarget"],
        ]
    case let .devices(requestId, inputs, outputs, defaultInputUid, defaultOutputUid):
        return [
            "type": "devices",
            "requestId": requestId,
            "inputs": inputs.map(deviceObject),
            "outputs": outputs.map(deviceObject),
            "defaultInputUid": defaultInputUid ?? NSNull(),
            "defaultOutputUid": defaultOutputUid ?? NSNull(),
        ]
    case let .started(requestId, sessionId, inputUid, outputTarget):
        return ["type": "started", "requestId": requestId, "sessionId": sessionId, "inputUid": inputUid, "outputTarget": outputTarget]
    case let .chunkReady(chunk):
        return [
            "type": "chunkReady",
            "sessionId": chunk.sessionId,
            "track": chunk.track.rawValue,
            "sequence": chunk.sequence,
            "startMs": chunk.startMs,
            "durationMs": chunk.durationMs,
            "path": chunk.path,
            "rmsDbfs": chunk.rmsDbfs,
        ]
    case let .stopped(sessionId, reason, lastSequence):
        var sequences: [String: Any] = [:]
        for track in Track.allCases {
            if let sequence = lastSequence[track] ?? nil {
                sequences[track.rawValue] = sequence
            } else {
                sequences[track.rawValue] = NSNull()
            }
        }
        return ["type": "stopped", "sessionId": sessionId, "reason": reason.rawValue, "lastSequence": sequences]
    case let .error(error, requestId, sessionId):
        return [
            "type": "error",
            "code": error.code,
            "message": error.message,
            "retryable": error.retryable,
            "target": error.target ?? NSNull(),
            "requestId": requestId ?? NSNull(),
            "sessionId": sessionId ?? NSNull(),
        ]
    }
}

private func deviceObject(_ device: DeviceInfo) -> [String: Any] {
    [
        "uid": device.uid,
        "name": device.name,
        "inputChannels": device.inputChannels,
        "outputChannels": device.outputChannels,
        "nominalSampleRate": device.nominalSampleRate,
    ]
}

/// 標準出力へ1行ずつ書く。複数のキューから呼ばれるため、行が混ざらないよう排他する。
public final class EventSink: @unchecked Sendable {
    private let lock = NSLock()
    private let write: (Data) -> Void

    /// 既定の書き込み先は標準出力。親が終了してパイプが閉じても例外で落ちないよう、失敗は無視する。
    /// 親の消失は標準入力のEOFで検知する。
    public init(write: @escaping (Data) -> Void = { try? FileHandle.standardOutput.write(contentsOf: $0) }) {
        self.write = write
    }

    public func emit(_ event: HelperEvent) {
        let data = encodeEvent(event)
        lock.lock()
        defer { lock.unlock() }
        write(data)
    }
}
