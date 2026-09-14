import { findFileWithData } from "../models/files";
import { listUnindexedGalleryPhotos, saveGalleryPhotoFaces } from "../models/gallery";
import { config } from "../config";
import { extractFaceEmbeddings, faceRecognitionEnabled } from "./faceRecognition";

const running = new Set<string>();
let backfillRunning = false;

export async function indexGalleryPhotoFaces(photoId: string, fileId: string): Promise<void> {
  if (!faceRecognitionEnabled() || running.has(photoId)) return;
  running.add(photoId);
  try {
    const file = await findFileWithData(fileId);
    if (!file) return;
    const result = await extractFaceEmbeddings(file.data, file.type, file.name);
    const embeddings = result.faces
      .filter((face) => face.detScore >= config.face.minDetectionScore)
      .map((face) => ({ embedding: face.embedding, detScore: face.detScore }));
    await saveGalleryPhotoFaces(photoId, { embeddings, model: result.model });
    console.log(`🙂 gallery photo ${photoId}: indexed ${embeddings.length} face(s)`);
  } catch (error) {
    console.error(`Face indexing failed for gallery photo ${photoId}`, error);
  } finally {
    running.delete(photoId);
  }
}

/** Indexes older photos gradually at startup; failures remain eligible for the next restart. */
export async function backfillGalleryFaces(): Promise<void> {
  if (!faceRecognitionEnabled() || backfillRunning) return;
  backfillRunning = true;
  try {
    for (;;) {
      const photos = await listUnindexedGalleryPhotos(10);
      if (photos.length === 0) return;
      for (const photo of photos) await indexGalleryPhotoFaces(photo._id, photo.fileId);
      // A completely unavailable service would otherwise spin forever on the same batch.
      const stillUnindexed = await listUnindexedGalleryPhotos(1);
      if (stillUnindexed.length > 0 && photos.some((photo) => photo._id === stillUnindexed[0]._id)) return;
    }
  } finally {
    backfillRunning = false;
  }
}
