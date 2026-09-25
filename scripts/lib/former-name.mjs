// Finds the product's former name. Only its SHA-256 is kept here, so this file does not spell the name it looks for.
// Every 8-letter window inside a run of Latin letters is hashed, case-insensitively, so the name is found inside longer identifiers too.

import { createHash } from "node:crypto";

const LENGTH = 8;
const HASH = "096690c7d63806fbf23ae48ba9d0e223bc3ff064fdb83796e10523265889f48b";

/** 1-based line numbers of text that contain the former name */
export function formerNameLines(text) {
  const lines = [];
  for (const [i, line] of text.split("\n").entries()) if (hasFormerName(line)) lines.push(i + 1);
  return lines;
}

export function hasFormerName(text) {
  for (const [run] of text.toLowerCase().matchAll(/[a-z]{8,}/g))
    for (let i = 0; i + LENGTH <= run.length; i++)
      if (
        createHash("sha256")
          .update(run.slice(i, i + LENGTH))
          .digest("hex") === HASH
      )
        return true;
  return false;
}
