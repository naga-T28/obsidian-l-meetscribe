import AVFoundation
import CoreAudio
import MeetingAudioCore

/// HALのIOProcで受けた入力を複製して渡す。マイクとタップで同じ経路を使い、時刻の扱いをそろえる。
private func makeIOBlock(format: AVAudioFormat, bytesPerFrame: UInt32, deliver: @escaping (AVAudioPCMBuffer, UInt64?) -> Void) -> AudioDeviceIOBlock {
    { _, inputData, inputTime, _, _ in
        guard bytesPerFrame > 0,
              let first = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData)).first
        else { return }
        let frames = AVAudioFrameCount(first.mDataByteSize / bytesPerFrame)
        guard let copy = copyBuffer(inputData, format: format, frames: frames) else { return }
        let time = inputTime.pointee
        deliver(copy, time.mFlags.contains(.hostTimeValid) ? HostClock.nanoseconds(fromTicks: time.mHostTime) : nil)
    }
}

/// 自分トラック。入力デバイスへ直接IOProcを登録する。AVAudioEngineの入力は、
/// 実機ではデバイスも形式も変わっていないのに開始直後に構成変更を通知したため使わない。
final class MicrophoneSource: CaptureSource {
    let track = Track.selfTrack
    let deviceID: AudioObjectID
    private var ioProcID: AudioDeviceIOProcID?
    private let ioQueue = DispatchQueue(label: "lms.helper.io.self")

    /// inputUIDがnilならシステム既定入力。開始時のデバイスIDに固定し、録音中に既定入力が変わっても追従しない（途中で話者の経路が入れ替わらないようにするため）。
    init(inputUID: String?) throws {
        deviceID = try inputUID.map(deviceID(forUID:)) ?? defaultDeviceID(kAudioHardwarePropertyDefaultInputDevice)
        guard channelCount(deviceID, scope: kAudioDevicePropertyScopeInput) > 0 else {
            throw HelperError("inputUnavailable", "the selected device has no input channels", retryable: true, target: track.rawValue)
        }
    }

    func start(deliver: @escaping (AVAudioPCMBuffer, UInt64?) -> Void) throws {
        var asbd = try readValue(deviceID, kAudioDevicePropertyStreamFormat, AudioStreamBasicDescription(), scope: kAudioDevicePropertyScopeInput)
        guard let format = AVAudioFormat(streamDescription: &asbd) else {
            throw HelperError("formatUnsupported", "input stream format is not supported", target: track.rawValue)
        }
        try check(
            AudioDeviceCreateIOProcIDWithBlock(&ioProcID, deviceID, ioQueue, makeIOBlock(format: format, bytesPerFrame: asbd.mBytesPerFrame, deliver: deliver)),
            "AudioDeviceCreateIOProcIDWithBlock(input)", code: "startFailed", target: track.rawValue
        )
        try check(AudioDeviceStart(deviceID, ioProcID), "AudioDeviceStart(input)", code: "startFailed", target: track.rawValue)
    }

    func stop() {
        if let ioProcID {
            AudioDeviceStop(deviceID, ioProcID)
            AudioDeviceDestroyIOProcID(deviceID, ioProcID)
        }
        ioProcID = nil
        // 停止前に積まれたIOブロックを処理し終えてから戻る。
        ioQueue.sync {}
    }
}

/// 相手トラック。Core Audioタップを集約デバイスに入れ、そのIOProcで受ける。
final class SystemAudioSource: CaptureSource {
    let track = Track.other
    /// nilなら全出力、値があればその出力デバイスだけを取る。
    let outputUID: String?
    private(set) var clockDeviceID = AudioObjectID(kAudioObjectUnknown)
    private(set) var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private let ioQueue = DispatchQueue(label: "lms.helper.io.other")

    init(outputUID: String?) {
        self.outputUID = outputUID
    }

    func start(deliver: @escaping (AVAudioPCMBuffer, UInt64?) -> Void) throws {
        let description: CATapDescription
        let clockUID: String
        if let outputUID {
            clockDeviceID = try deviceID(forUID: outputUID)
            description = CATapDescription(excludingProcesses: [], deviceUID: outputUID, stream: 0)
            clockUID = outputUID
        } else {
            clockDeviceID = try defaultDeviceID(kAudioHardwarePropertyDefaultSystemOutputDevice)
            description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
            clockUID = try deviceUID(clockDeviceID)
        }
        description.uuid = UUID()
        description.name = "L Meetscribe Tap"
        description.isPrivate = true
        // 会議の音を利用者が聞けなくならないよう、元の再生は止めない。
        description.muteBehavior = .unmuted
        try check(AudioHardwareCreateProcessTap(description, &tapID), "AudioHardwareCreateProcessTap", code: "startFailed", target: track.rawValue)

        var asbd = try readValue(tapID, kAudioTapPropertyFormat, AudioStreamBasicDescription())
        guard let format = AVAudioFormat(streamDescription: &asbd) else {
            throw HelperError("formatUnsupported", "tap stream format is not supported", target: track.rawValue)
        }
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "L Meetscribe",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: clockUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            // trueだと何も再生していない間は集約デバイスのIOが始まらず、マイクの開始も時間切れになる（実機で確認）。
            kAudioAggregateDeviceTapAutoStartKey: false,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: clockUID]],
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapUIDKey: description.uuid.uuidString,
                kAudioSubTapDriftCompensationKey: true,
            ]],
        ]
        try check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID), "AudioHardwareCreateAggregateDevice", code: "startFailed", target: track.rawValue)
        try check(
            AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, ioQueue, makeIOBlock(format: format, bytesPerFrame: asbd.mBytesPerFrame, deliver: deliver)),
            "AudioDeviceCreateIOProcIDWithBlock(tap)", code: "startFailed", target: track.rawValue
        )
        try check(AudioDeviceStart(aggregateID, ioProcID), "AudioDeviceStart(tap)", code: "startFailed", target: track.rawValue)
    }

    /// 途中で失敗した場合も、作成済みの資源だけを逆順に解放する。
    func stop() {
        if aggregateID != kAudioObjectUnknown {
            if let ioProcID {
                AudioDeviceStop(aggregateID, ioProcID)
                AudioDeviceDestroyIOProcID(aggregateID, ioProcID)
            }
            AudioHardwareDestroyAggregateDevice(aggregateID)
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
        }
        ioProcID = nil
        aggregateID = AudioObjectID(kAudioObjectUnknown)
        tapID = AudioObjectID(kAudioObjectUnknown)
        ioQueue.sync {}
    }
}

/// 使用中デバイスの消失と形式の変更を監視する。既定デバイスの変更では録音を止めない（使用中のデバイスは開始時に固定しているため）。
final class DeviceMonitor {
    private var registrations: [(AudioObjectID, AudioObjectPropertyAddress, AudioObjectPropertyListenerBlock)] = []
    private let queue = DispatchQueue(label: "lms.helper.devices")

    /// watchedDevicesは（トラック, デバイス）、formatWatchesは（トラック, オブジェクト, セレクター, スコープ）。
    func start(
        watchedDevices: [(Track, AudioObjectID)],
        formatWatches: [(Track, AudioObjectID, AudioObjectPropertySelector, AudioObjectPropertyScope)],
        onFailure: @escaping (HelperError) -> Void
    ) throws {
        let checkAlive = {
            for (track, id) in watchedDevices where !isDeviceAlive(id) {
                onFailure(HelperError("deviceDisconnected", "\(track.rawValue) device was disconnected", retryable: true, target: track.rawValue))
            }
        }
        try listen(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDevices, handler: checkAlive)
        for (_, id) in watchedDevices {
            try listen(id, kAudioDevicePropertyDeviceIsAlive, handler: checkAlive)
        }
        for (track, objectID, selector, scope) in formatWatches {
            try listen(objectID, selector, scope) {
                onFailure(HelperError("formatChanged", "\(track.rawValue) stream format changed", retryable: true, target: track.rawValue))
            }
        }
        for (track, id) in watchedDevices {
            try listen(id, kAudioDevicePropertyNominalSampleRate) {
                onFailure(HelperError("formatChanged", "\(track.rawValue) sample rate changed", retryable: true, target: track.rawValue))
            }
        }
    }

    private func listen(
        _ objectID: AudioObjectID,
        _ selector: AudioObjectPropertySelector,
        _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
        handler: @escaping () -> Void
    ) throws {
        var property = address(selector, scope)
        let block: AudioObjectPropertyListenerBlock = { _, _ in handler() }
        try check(AudioObjectAddPropertyListenerBlock(objectID, &property, queue, block), "listen \(selector)", code: "startFailed")
        registrations.append((objectID, property, block))
    }

    func stop() {
        for (objectID, property, block) in registrations {
            var property = property
            AudioObjectRemovePropertyListenerBlock(objectID, &property, queue, block)
        }
        registrations.removeAll()
    }
}
