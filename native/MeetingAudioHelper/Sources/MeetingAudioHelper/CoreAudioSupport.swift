import CoreAudio
import MeetingAudioCore

func check(_ status: OSStatus, _ label: String, code: String = "coreAudio", target: String? = nil) throws {
    guard status == noErr else { throw HelperError(code, "\(label) failed: OSStatus \(status)", target: target) }
}

func address(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func readValue<T: BitwiseCopyable>(_ objectID: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T, scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) throws -> T {
    var property = address(selector, scope)
    var value = initial
    var size = UInt32(MemoryLayout<T>.size)
    try check(AudioObjectGetPropertyData(objectID, &property, 0, nil, &size, &value), "read property \(selector)")
    return value
}

func readString(_ objectID: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var property = address(selector)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(objectID, &property, 0, nil, &size, &value) == noErr else { return nil }
    return value?.takeRetainedValue() as String?
}

func channelCount(_ deviceID: AudioObjectID, scope: AudioObjectPropertyScope) -> Int {
    var property = address(kAudioDevicePropertyStreamConfiguration, scope)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(deviceID, &property, 0, nil, &size) == noErr, size > 0 else { return 0 }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    let list = raw.assumingMemoryBound(to: AudioBufferList.self)
    guard AudioObjectGetPropertyData(deviceID, &property, 0, nil, &size, list) == noErr else { return 0 }
    return UnsafeMutableAudioBufferListPointer(list).reduce(0) { $0 + Int($1.mNumberChannels) }
}

func allDeviceIDs() throws -> [AudioObjectID] {
    var property = address(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    let system = AudioObjectID(kAudioObjectSystemObject)
    try check(AudioObjectGetPropertyDataSize(system, &property, 0, nil, &size), "device list size")
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    try check(AudioObjectGetPropertyData(system, &property, 0, nil, &size, &ids), "device list")
    return ids
}

func defaultDeviceID(_ selector: AudioObjectPropertySelector) throws -> AudioObjectID {
    try readValue(AudioObjectID(kAudioObjectSystemObject), selector, AudioObjectID(kAudioObjectUnknown))
}

func deviceID(forUID uid: String) throws -> AudioObjectID {
    for id in try allDeviceIDs() where readString(id, kAudioDevicePropertyDeviceUID) == uid {
        return id
    }
    throw HelperError("deviceNotFound", "no device with the requested UID", retryable: true)
}

func deviceUID(_ deviceID: AudioObjectID) throws -> String {
    guard let uid = readString(deviceID, kAudioDevicePropertyDeviceUID) else {
        throw HelperError("deviceNotFound", "device \(deviceID) has no UID", retryable: true)
    }
    return uid
}

func isDeviceAlive(_ deviceID: AudioObjectID) -> Bool {
    (try? readValue(deviceID, kAudioDevicePropertyDeviceIsAlive, UInt32(0))) == 1
}

/// 集約デバイスなど、このヘルパーが作った非公開デバイスは一覧に出ない。
func listDevices() throws -> (inputs: [DeviceInfo], outputs: [DeviceInfo], defaultInputUid: String?, defaultOutputUid: String?) {
    let devices = try allDeviceIDs().compactMap { id -> DeviceInfo? in
        guard let uid = readString(id, kAudioDevicePropertyDeviceUID) else { return nil }
        return DeviceInfo(
            uid: uid,
            name: readString(id, kAudioObjectPropertyName) ?? uid,
            inputChannels: channelCount(id, scope: kAudioDevicePropertyScopeInput),
            outputChannels: channelCount(id, scope: kAudioDevicePropertyScopeOutput),
            nominalSampleRate: (try? readValue(id, kAudioDevicePropertyNominalSampleRate, Float64(0))) ?? 0
        )
    }
    return (
        devices.filter { $0.inputChannels > 0 },
        devices.filter { $0.outputChannels > 0 },
        (try? defaultDeviceID(kAudioHardwarePropertyDefaultInputDevice)).flatMap { readString($0, kAudioDevicePropertyDeviceUID) },
        (try? defaultDeviceID(kAudioHardwarePropertyDefaultOutputDevice)).flatMap { readString($0, kAudioDevicePropertyDeviceUID) }
    )
}

/// HALは既定でメインスレッドのRunLoopを通知に使う。開始処理がメインスレッドを止めている間に
/// HALがそれを待つとIOスレッドの起動が時間切れになる疑いがある（実機で起動が止まった）。そのため通知はHAL自身のスレッドで処理させる。
func useHALOwnNotificationThread() throws {
    var runLoop: UnsafeRawPointer? = nil
    var property = address(kAudioHardwarePropertyRunLoop)
    try check(
        AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &property, 0, nil, UInt32(MemoryLayout<UnsafeRawPointer?>.size), &runLoop),
        "set HAL run loop"
    )
}
