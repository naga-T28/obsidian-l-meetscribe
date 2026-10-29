// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "MeetingAudioHelper",
    platforms: [.macOS("14.2")],
    targets: [
        // Core Audioのデバイスに依存しない処理。swift testで検証する。
        .target(name: "MeetingAudioCore"),
        .executableTarget(
            name: "MeetingAudioHelper",
            dependencies: ["MeetingAudioCore"],
            linkerSettings: [
                // .app化せず、単一の実行ファイルにマイク・システム音声の使用目的文字列を埋め込む。Obsidianから直接起動すれば許可はObsidianに付くため。パッケージのフォルダで実行する。
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", "Info.plist"]),
            ]
        ),
        .testTarget(name: "MeetingAudioCoreTests", dependencies: ["MeetingAudioCore"]),
    ]
)
