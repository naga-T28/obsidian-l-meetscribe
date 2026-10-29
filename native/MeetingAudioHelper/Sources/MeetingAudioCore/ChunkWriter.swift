import Foundation

/// チャンクのWAVとメタ情報を作業領域の`chunks/`へ書く。
/// どちらも一時名で書いて同期・クローズしてから確定名へ変更する。WAV、メタ情報の順に確定し、
/// 呼び出し元はその後で通知する。復旧時は確定名のファイルだけを完成済みとして扱える。
public final class ChunkWriter {
    public static let directoryName = "chunks"

    private let sessionId: String
    private let directory: URL
    private let windowFrames: Int

    public init(workDir: URL, sessionId: String, windowFrames: Int) throws {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: workDir.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw HelperError("workDirUnavailable", "work directory does not exist")
        }
        self.sessionId = sessionId
        self.windowFrames = windowFrames
        directory = workDir.appendingPathComponent(Self.directoryName, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        } catch {
            throw HelperError("workDirUnavailable", "cannot create chunks directory (it may already exist): \(error.localizedDescription)")
        }
    }

    public func write(track: Track, chunk: ChunkedAudio) throws -> ChunkNotice {
        let baseName = String(format: "%@-%06d", track.rawValue, chunk.sequence)
        let relativePath = "\(Self.directoryName)/\(baseName).wav"
        let notice = ChunkNotice(
            sessionId: sessionId,
            track: track,
            sequence: chunk.sequence,
            startMs: Timeline.milliseconds(frames: Int64(chunk.sequence) * Int64(windowFrames)),
            durationMs: Timeline.milliseconds(frames: Int64(chunk.samples.count)),
            path: relativePath,
            rmsDbfs: WAV.rmsDbfs(chunk.samples)
        )
        let metadata: [String: Any] = [
            "sessionId": notice.sessionId,
            "track": notice.track.rawValue,
            "sequence": notice.sequence,
            "startMs": notice.startMs,
            "durationMs": notice.durationMs,
            "path": notice.path,
            "rmsDbfs": notice.rmsDbfs,
        ]
        do {
            try writeAtomically(WAV.encode(samples: chunk.samples), name: "\(baseName).wav")
            try writeAtomically(JSONSerialization.data(withJSONObject: metadata, options: [.sortedKeys]), name: "\(baseName).json")
        } catch let error as HelperError {
            throw error
        } catch {
            throw HelperError("writeFailed", "\(track.rawValue) chunk \(chunk.sequence): \(error.localizedDescription)", target: track.rawValue)
        }
        return notice
    }

    private func writeAtomically(_ data: Data, name: String) throws {
        let finalPath = directory.appendingPathComponent(name).path
        let tempPath = directory.appendingPathComponent(".\(name).tmp").path
        // 同じ番号のチャンクを上書きしない。上書きは通知済みの内容を変えてしまう。
        guard !FileManager.default.fileExists(atPath: finalPath) else {
            throw HelperError("writeFailed", "\(name) already exists")
        }
        let fd = open(tempPath, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
        guard fd >= 0 else { throw posixError("open", name) }
        var closed = false
        defer {
            if !closed { close(fd) }
        }
        try data.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let written = Darwin.write(fd, buffer.baseAddress! + offset, buffer.count - offset)
                guard written > 0 else { throw posixError("write", name) }
                offset += written
            }
        }
        guard fsync(fd) == 0 else { throw posixError("fsync", name) }
        closed = true
        guard close(fd) == 0 else { throw posixError("close", name) }
        guard rename(tempPath, finalPath) == 0 else { throw posixError("rename", name) }
    }

    private func posixError(_ operation: String, _ name: String) -> HelperError {
        HelperError("writeFailed", "\(operation) \(name): \(String(cString: strerror(errno)))")
    }
}
