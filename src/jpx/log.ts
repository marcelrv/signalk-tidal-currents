// SPDX-FileCopyrightText: 2012 Mozilla Foundation
// SPDX-License-Identifier: Apache-2.0

const debug = false;

export function info(...args: unknown[]): void {
  if (debug) console.log('INFO', ...args);
}

export function warn(...args: unknown[]): void {
  if (debug) console.log('WARN', ...args);
}
