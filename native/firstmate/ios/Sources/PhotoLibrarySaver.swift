import Foundation
import Photos
import UniformTypeIdentifiers

/// An add-only copy of one photo or video in the photo library. Nothing calls this unless the
/// page asked: handed-over files and uploads stay in the app's private storage. The app asks
/// for add-only access (NSPhotoLibraryAddUsageDescription) and can never read the library.
enum PhotoLibrarySaver {
    /// `completion` receives nil when the copy is saved, or the error code the page gets. It may be called on any queue.
    static func save(file: URL, fileName: String?, contentType: String?, completion: @escaping (String?) -> Void) {
        let type = OfflineUploadRules.contentType(contentType, fallback: "")
        let video = type.hasPrefix("video/")
        guard video || type.hasPrefix("image/") else { completion("unsupported_media"); return }
        guard FileManager.default.fileExists(atPath: file.path) else { completion("unknown_source"); return }
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else { completion("photos_permission_denied"); return }
            // Photos reads the kind of file from its extension, and handed-over files have none: work on a named copy.
            let name = OfflineUploadRules.fileName(fileName, fallback: "FirstMate")
            let named = URL(fileURLWithPath: name).pathExtension
            let ext = named.isEmpty ? (UTType(mimeType: type)?.preferredFilenameExtension ?? (video ? "mp4" : "jpg")) : named
            let copy = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension(ext)
            do { try FileManager.default.copyItem(at: file, to: copy) } catch { completion("photos_save_failed"); return }
            PHPhotoLibrary.shared().performChanges({
                let options = PHAssetResourceCreationOptions()
                options.originalFilename = name
                options.shouldMoveFile = true
                PHAssetCreationRequest.forAsset().addResource(with: video ? .video : .photo, fileURL: copy, options: options)
            }, completionHandler: { saved, _ in
                try? FileManager.default.removeItem(at: copy)
                completion(saved ? nil : "photos_save_failed")
            })
        }
    }
}
