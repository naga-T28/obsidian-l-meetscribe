import Foundation
import Testing
@testable import MeetingAudioCore

@Suite struct ProtocolTests {
    @Test("各コマンドを読む") func case1() throws {
        #expect(try parseCommand(#"{"type":"hello","requestId":"r1","protocolVersion":1}"#) == .hello(requestId: "r1", protocolVersion: 1))
        #expect(try parseCommand(#"{"type":"listDevices","requestId":"r2"}"#) == .listDevices(requestId: "r2"))
        #expect(try parseCommand(#"{"type":"stop","sessionId":"s-1"}"#) == .stop(sessionId: "s-1"))
        #expect(try parseCommand(#"{"type":"heartbeat","sessionId":"s-1"}"#) == .heartbeat(sessionId: "s-1"))
        let start = try parseCommand(#"{"type":"start","requestId":"r3","sessionId":"s-1","inputUid":null,"outputUid":"BuiltInSpeaker","chunkSeconds":10,"workDir":"/Users/a/Library/Application Support/L Meetscribe/v/sessions/s-1"}"#)
        #expect(start == .start(StartParameters(
            requestId: "r3",
            sessionId: "s-1",
            inputUid: nil,
            outputUid: "BuiltInSpeaker",
            chunkSeconds: 10,
            workDir: "/Users/a/Library/Application Support/L Meetscribe/v/sessions/s-1"
        )))
    }

    @Test("不正なメッセージを拒否する", arguments: [
        "not json",
        "[]",
        #"{"type":"unknown"}"#,
        #"{"type":"hello","requestId":"r","protocolVersion":1.5}"#,
        #"{"type":"hello","requestId":"r","protocolVersion":true}"#,
        #"{"type":"hello","requestId":"","protocolVersion":1}"#,
        #"{"type":"stop","sessionId":"../x"}"#,
        #"{"type":"stop","sessionId":"s/1"}"#,
        #"{"type":"stop"}"#,
        #"{"type":"start","requestId":"r","sessionId":"s","chunkSeconds":0,"workDir":"/tmp/s"}"#,
        #"{"type":"start","requestId":"r","sessionId":"s","chunkSeconds":10,"workDir":"relative/s"}"#,
        #"{"type":"start","requestId":"r","sessionId":"s","chunkSeconds":10,"workDir":"/tmp/a/../b"}"#,
        #"{"type":"start","requestId":"r","sessionId":"s","chunkSeconds":10,"workDir":"/tmp/s/"}"#,
        #"{"type":"start","requestId":"r","sessionId":"s","chunkSeconds":10,"workDir":"/tmp/s","inputUid":""}"#,
    ])
    func case7(line: String) {
        #expect(throws: HelperError.self) { try parseCommand(line) }
    }

    @Test("不正なメッセージはbadMessageとして扱う") func case2() {
        do {
            _ = try parseCommand("{")
            Issue.record("parse should fail")
        } catch let error as HelperError {
            #expect(error.code == "badMessage")
        } catch {
            Issue.record("unexpected error \(error)")
        }
    }

    private func decode(_ event: HelperEvent) throws -> [String: Any] {
        let data = encodeEvent(event)
        #expect(data.last == 0x0A)
        #expect(data.dropLast().contains(0x0A) == false)
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    @Test("チャンク通知を1行のJSONで書く") func case3() throws {
        let object = try decode(.chunkReady(ChunkNotice(sessionId: "s-1", track: .selfTrack, sequence: 3, startMs: 30_000, durationMs: 10_000, path: "chunks/self-000003.wav", rmsDbfs: -42.5)))
        #expect(object["type"] as? String == "chunkReady")
        #expect(object["track"] as? String == "self")
        #expect(object["sequence"] as? Int == 3)
        #expect(object["startMs"] as? Double == 30_000)
        #expect(object["durationMs"] as? Double == 10_000)
        #expect(object["path"] as? String == "chunks/self-000003.wav")
        #expect(object["rmsDbfs"] as? Double == -42.5)
    }

    @Test("停止通知は通知していないトラックの番号をnullにする") func case4() throws {
        let object = try decode(.stopped(sessionId: "s-1", reason: .stdinClosed, lastSequence: [.selfTrack: 4, .other: nil]))
        let sequences = object["lastSequence"] as! [String: Any]
        #expect(object["reason"] as? String == "stdinClosed")
        #expect(sequences["self"] as? Int == 4)
        #expect(sequences["other"] is NSNull)
    }

    @Test("エラー通知にコードと再試行可否を含める") func case5() throws {
        let object = try decode(.error(HelperError("trackStalled", "other: no audio", retryable: true, target: "other"), requestId: nil, sessionId: "s-1"))
        #expect(object["code"] as? String == "trackStalled")
        #expect(object["retryable"] as? Bool == true)
        #expect(object["target"] as? String == "other")
        #expect(object["requestId"] is NSNull)
    }

    @Test("readyにプロトコル版とヘルパー版を含める") func case6() throws {
        let object = try decode(.ready(requestId: "r1", helperVersion: "0.1.0"))
        #expect(object["protocolVersion"] as? Int == helperProtocolVersion)
        #expect(object["helperVersion"] as? String == "0.1.0")
    }
}
