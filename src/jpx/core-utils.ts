// SPDX-FileCopyrightText: 2012 Mozilla Foundation
// SPDX-License-Identifier: Apache-2.0

export function log2(x: number): number {
  if (x <= 0) return 0;
  return Math.ceil(Math.log2(x));
}

export function readUint16(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1];
}

export function readUint32(data: Uint8Array, offset: number): number {
  return (
    data[offset] * 0x1000000 +
    (data[offset + 1] << 16) +
    (data[offset + 2] << 8) +
    data[offset + 3]
  );
}

export function readInt8(data: Uint8Array, offset: number): number {
  const v = data[offset];
  return v & 0x80 ? -(v & 0x7f) : v;
}
