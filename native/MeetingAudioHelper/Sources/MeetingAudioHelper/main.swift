// L Meetscribeの録音ヘルパー。Obsidianから直接起動し、標準入出力のJSON Linesで通信する。
// 直接起動すると、マイクとシステム音声の許可はObsidianに付く。
// 1プロセスで録音するのは1セッションだけで、録音を止めたら終了する。音声は作業領域のファイルにだけ書く。
import AVFoundation
import CoreAudio
import Foundation
import MeetingAudioCore

/// AudioDeviceStartは戻るまで呼び出し元を止める。実機ではcoreaudiodがIOスレッドの起動に失敗し続け、
/// 約12分戻らなかった。期限を過ぎたら資源ごとプロセスを終了する。
let startTimeoutSeconds: Double = 15

/// 実行ファイルに埋め込んだInfo.plistの版。プラグインは`ready`でこの版がmanifest.jsonと一致するかを確認する。
/// 読めない場合も起動は続け、版の不一致としてプラグインに拒否させる。
let helperVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"

let sink = EventSink()

final class Helper {
    private var helloReceived = false
    private var recordingRequested = false
    private var sessionId: String?
    private var controller: RecordingController?
    private let monitor = DeviceMonitor()
    private var healthTimer: DispatchSourceTimer?
    private var lastHeartbeatNs: UInt64 = 0

    /// main queueで呼ぶ。
    func handle(line: String) {
        let command: HelperCommand
        do {
            command = try parseCommand(line)
        } catch {
            sink.emit(.error(asHelperError(error), requestId: nil, sessionId: sessionId))
            return
        }
        switch command {
        case let .hello(requestId, version):
            guard version == helperProtocolVersion else {
                sink.emit(.error(HelperError("unsupportedVersion", "helper supports protocol version \(helperProtocolVersion)"), requestId: requestId, sessionId: nil))
                return
            }
            helloReceived = true
            sink.emit(.ready(requestId: requestId, helperVersion: helperVersion))
        case let .listDevices(requestId):
            guard requireHello(requestId: requestId) else { return }
            do {
                let devices = try MeetingAudioHelper.listDevices()
                sink.emit(.devices(requestId: requestId, inputs: devices.inputs, outputs: devices.outputs, defaultInputUid: devices.defaultInputUid, defaultOutputUid: devices.defaultOutputUid))
            } catch {
                sink.emit(.error(asHelperError(error), requestId: requestId, sessionId: nil))
            }
        case let .start(parameters):
            guard requireHello(requestId: parameters.requestId) else { return }
            guard !recordingRequested else {
                sink.emit(.error(HelperError("invalidState", "this helper has already started a session"), requestId: parameters.requestId, sessionId: parameters.sessionId))
                return
            }
            recordingRequested = true
            sessionId = parameters.sessionId
            startRecording(parameters)
        case let .stop(requestedSessionId):
            guard requireSession(requestedSessionId) else { return }
            controller?.stop(reason: .stopCommand)
        case let .heartbeat(requestedSessionId):
            guard requireSession(requestedSessionId) else { return }
            lastHeartbeatNs = HostClock.nowNanoseconds()
        }
    }

    /// 標準入力のEOF。親プロセスの消失を含む。
    func handleInputClosed() {
        stopOrExit(reason: .stdinClosed)
    }

    func handleSignal() {
        stopOrExit(reason: .signal)
    }

    /// 開始処理はmain queueを占有するため、ここが呼ばれるのは開始の前か、開始が済んだ後だけになる。
    private func stopOrExit(reason: StopReason) {
        guard let controller else { exit(0) }
        controller.stop(reason: reason)
    }

    private func startRecording(_ parameters: StartParameters) {
        func fail(_ error: Error) -> Never {
            sink.emit(.error(asHelperError(error), requestId: parameters.requestId, sessionId: parameters.sessionId))
            exit(1)
        }
        // 不正な要求で許可ダイアログを出さないよう、作業領域を先に確認する。
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: parameters.workDir, isDirectory: &isDirectory), isDirectory.boolValue else {
            fail(HelperError("workDirUnavailable", "work directory does not exist"))
        }
        // 許可ダイアログへの応答待ちを開始の期限に含めないよう、期限より前に確認する。
        do {
            try ensureMicrophoneAccess()
        } catch {
            fail(error)
        }
        // 開始の基準時刻。両トラックの時刻はここからの経過時間で表す。
        let originNs = HostClock.nowNanoseconds()
        let startFinished = StartFlag()
        DispatchQueue.global().asyncAfter(deadline: .now() + startTimeoutSeconds) {
            guard !startFinished.isSet else { return }
            sink.emit(.error(HelperError("startTimeout", "recording did not start within \(Int(startTimeoutSeconds))s", retryable: true), requestId: parameters.requestId, sessionId: parameters.sessionId))
            exit(1)
        }

        let microphone: MicrophoneSource
        let system = SystemAudioSource(outputUID: parameters.outputUid)
        let controller: RecordingController
        do {
            microphone = try MicrophoneSource(inputUID: parameters.inputUid)
            controller = try RecordingController(
                sessionId: parameters.sessionId,
                originNs: originNs,
                chunkSeconds: parameters.chunkSeconds,
                workDir: URL(fileURLWithPath: parameters.workDir, isDirectory: true),
                // タップを先に開始する（実機で安定した順序）。
                sources: [system, microphone],
                sink: sink,
                queue: .main,
                onFinished: { [weak self] exitCode in
                    self?.monitor.stop()
                    self?.healthTimer?.cancel()
                    exit(exitCode)
                }
            )
            try controller.start()
        } catch {
            startFinished.set()
            fail(error)
        }
        startFinished.set()
        self.controller = controller
        do {
            try monitor.start(
                watchedDevices: [(.selfTrack, microphone.deviceID), (.other, system.clockDeviceID)],
                formatWatches: [
                    (.selfTrack, microphone.deviceID, kAudioDevicePropertyStreamFormat, kAudioDevicePropertyScopeInput),
                    (.other, system.tapID, kAudioTapPropertyFormat, kAudioObjectPropertyScopeGlobal),
                ],
                onFailure: { error in DispatchQueue.main.async { controller.stop(reason: .error, error: error) } }
            )
        } catch {
            controller.stop(reason: .error, error: asHelperError(error))
            return
        }
        sink.emit(.started(
            requestId: parameters.requestId,
            sessionId: parameters.sessionId,
            inputUid: (try? deviceUID(microphone.deviceID)) ?? "",
            outputTarget: parameters.outputUid ?? "all"
        ))
        lastHeartbeatNs = HostClock.nowNanoseconds()
        startHealthTimer(controller)
    }

    private func startHealthTimer(_ controller: RecordingController) {
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            controller.checkHealth()
            let silentNs = HostClock.nowNanoseconds() - self.lastHeartbeatNs
            if Double(silentNs) / 1e9 > heartbeatTimeoutSeconds {
                controller.stop(reason: .heartbeatTimeout)
            }
        }
        timer.resume()
        healthTimer = timer
    }

    private func requireHello(requestId: String) -> Bool {
        if !helloReceived {
            sink.emit(.error(HelperError("invalidState", "hello is required first"), requestId: requestId, sessionId: nil))
        }
        return helloReceived
    }

    /// 別セッション宛ての操作を拒否する。
    private func requireSession(_ requested: String) -> Bool {
        guard sessionId == requested else {
            sink.emit(.error(HelperError("sessionMismatch", "no recording for the requested session"), requestId: nil, sessionId: requested))
            return false
        }
        return true
    }
}

/// マイクの拒否は公開APIで判定できるため、開始前に確かめる。拒否されたまま無音で録音を続けない。
/// システム音声の許可状態は読めないため、ここでは確認しない。
func ensureMicrophoneAccess() throws {
    var status = AVCaptureDevice.authorizationStatus(for: .audio)
    if status == .notDetermined {
        let semaphore = DispatchSemaphore(value: 0)
        AVCaptureDevice.requestAccess(for: .audio) { _ in semaphore.signal() }
        semaphore.wait()
        status = AVCaptureDevice.authorizationStatus(for: .audio)
    }
    guard status == .authorized else {
        throw HelperError("microphoneDenied", "microphone access is not authorized (status \(status.rawValue))", target: Track.selfTrack.rawValue)
    }
}

func asHelperError(_ error: Error) -> HelperError {
    error as? HelperError ?? HelperError("unexpected", "\(error)")
}

final class StartFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var isSet: Bool { lock.withLock { value } }
    func set() { lock.withLock { value = true } }
}

// MARK: - エントリポイント

let helper = Helper()
do {
    try useHALOwnNotificationThread()
} catch {
    sink.emit(.error(asHelperError(error), requestId: nil, sessionId: nil))
    exit(1)
}
// 親が終了して標準出力が閉じても、SIGPIPEで後始末をせずに終了しないようにする。
signal(SIGPIPE, SIG_IGN)
var signalSources: [DispatchSourceSignal] = []
for signalNumber in [SIGINT, SIGTERM] {
    signal(signalNumber, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
    source.setEventHandler { helper.handleSignal() }
    source.resume()
    signalSources.append(source)
}
Thread {
    while let line = readLine() {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { continue }
        DispatchQueue.main.async { helper.handle(line: trimmed) }
    }
    DispatchQueue.main.async { helper.handleInputClosed() }
}.start()
RunLoop.main.run()
