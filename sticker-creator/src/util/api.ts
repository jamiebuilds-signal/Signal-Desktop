// Copyright 2022 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import b64 from 'base64-js';

import { type ArtType } from '../constants';
import { type EncryptResult } from './crypto';
import type { InitializeFromForkPayload } from '../slices/art';

// The raw, over-the-wire shape handed off by the main window: one entry per
// sticker in the source pack, keyed by its numeric sticker id rather than a
// local file path (there is no local file for a forked sticker).
export type RawForkPayload = Readonly<{
  title: string;
  author: string;
  stickers: ReadonlyArray<{
    id: number;
    contentType: string;
    buffer: Uint8Array<ArrayBuffer>;
    isCover: boolean;
    emoji?: { emoji: string; name: string };
  }>;
}>;

declare global {
  // eslint-disable-next-line no-restricted-syntax
  interface Window {
    uploadStickerPack(
      manifest: Uint8Array<ArrayBuffer>,
      stickers: ReadonlyArray<Uint8Array<ArrayBuffer>>,
      onProgres?: () => void
    ): Promise<string>;
    installStickerPack(packId: string, key: string): void;
    getFilePath(file: File): string;
    getForkPayload(): Promise<RawForkPayload | undefined>;
  }
}

export type UploadOptions = Readonly<{
  artType: ArtType;
  onProgress?: () => void;
}>;

export class APIError extends Error {
  constructor(message: string, public readonly errorMessageI18nKey: string) {
    super(message);
  }
}

export type UploadResult = Readonly<{
  key: string;
  packId: string;
}>;

export async function upload(
  encryptResult: EncryptResult,
  { onProgress }: UploadOptions
): Promise<UploadResult> {
  const { encryptedManifest, encryptedImages, key } = encryptResult;

  const packId = await window.uploadStickerPack(
    encryptedManifest,
    encryptedImages,
    onProgress
  );

  window.installStickerPack(packId, key);

  return {
    key,
    packId,
  };
}

export function getFilePath(file: File): string {
  return window.getFilePath(file);
}

export async function getForkPayload(): Promise<
  InitializeFromForkPayload | undefined
> {
  const payload = await window.getForkPayload();
  if (!payload) {
    return undefined;
  }

  return {
    title: payload.title,
    author: payload.author,
    stickers: payload.stickers.map(sticker => {
      const path = `fork-sticker-${sticker.id}`;
      return {
        path,
        isCover: sticker.isCover,
        emoji: sticker.emoji && {
          emoji: sticker.emoji.emoji,
          name: sticker.emoji.name,
          sheetX: -1,
          sheetY: -1,
        },
        imageData: {
          buffer: sticker.buffer,
          contentType: sticker.contentType,
          path,
          src: `data:${sticker.contentType};base64,${b64.fromByteArray(
            sticker.buffer
          )}`,
        },
      };
    }),
  };
}
