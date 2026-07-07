// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

import { JpxImage as _JpxImage } from './jpx.js';

export interface Tile {
  height: number;
  width: number;
  top: number;
  left: number;
  items: Float64Array;
}

export interface JpxImageInstance {
  parse: (data: Uint8Array) => void;
  width: number;
  height: number;
  componentsCount: number;
  bitsPerComponent: number;
  tiles: Tile[];
  failOnCorruptedImage: boolean;
}

const JpxImage = _JpxImage as unknown as { new (): JpxImageInstance };

export function decodeJpeg2000Codestream(data: Uint8Array): Float64Array {
  const jpx = new JpxImage();
  jpx.parse(data);
  if (!jpx.tiles || jpx.tiles.length === 0) {
    throw new Error('JPEG2000 decode returned no tiles');
  }
  return jpx.tiles[0].items;
}
