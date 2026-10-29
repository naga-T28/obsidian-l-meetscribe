import Darwin

/// 出力するWAVのサンプルレート。whisper.cppの入力形式に合わせる。
public let outputSampleRate = 16_000

/// ホスト時刻（mach_absolute_timeの単位）をナノ秒へ換算する。
public enum HostClock {
    private static let timebase: mach_timebase_info_data_t = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return info
    }()

    public static func nanoseconds(fromTicks ticks: UInt64) -> UInt64 {
        // 乗算の桁あふれを避けるため、商と余りに分けて換算する。
        let numer = UInt64(timebase.numer)
        let denom = UInt64(timebase.denom)
        return ticks / denom * numer + ticks % denom * numer / denom
    }

    public static func nowNanoseconds() -> UInt64 {
        nanoseconds(fromTicks: mach_absolute_time())
    }
}

/// 録音開始からの時間と、16kHzのサンプル数・ミリ秒の換算。
public enum Timeline {
    public static func frames(fromNanoseconds nanoseconds: Int64) -> Int64 {
        Int64((Double(nanoseconds) * Double(outputSampleRate) / 1_000_000_000).rounded())
    }

    public static func milliseconds(frames: Int64) -> Double {
        Double(frames) * 1_000 / Double(outputSampleRate)
    }

    public static func windowFrames(chunkSeconds: Double) -> Int {
        max(1, Int((chunkSeconds * Double(outputSampleRate)).rounded()))
    }
}
