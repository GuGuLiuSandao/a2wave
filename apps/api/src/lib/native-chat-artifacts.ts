import {
  MAX_ZIP_SOURCE_BYTES,
  type RegisteredArtifact,
  getDirectorySourceSize,
  zipDirectoryToBuffer,
} from './artifact-storage.js'
import { logger } from './logger.js'

export interface NativeArtifactUpload {
  filename: string
  data: string | Buffer
}

/**
 * Prepare one registered artifact for a native chat SDK. File artifacts are
 * streamed from their persisted storage path. Directories are zipped after a
 * source-size guard because the zip helper builds the archive in memory.
 */
export function prepareNativeArtifactUpload(
  artifact: RegisteredArtifact,
): NativeArtifactUpload | null {
  if (artifact.kind === 'file') {
    return { filename: artifact.filename, data: artifact.storagePath }
  }

  const sourceSize = getDirectorySourceSize(artifact.storagePath)
  if (sourceSize > MAX_ZIP_SOURCE_BYTES) {
    logger.warn(
      { artifactId: artifact.id, filename: artifact.filename, sourceSize },
      'Directory artifact is too large to package for native chat',
    )
    return null
  }
  return {
    filename: `${artifact.filename}.zip`,
    data: zipDirectoryToBuffer(artifact.storagePath, artifact.filename),
  }
}
