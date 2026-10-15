/* Copied from Web/Node/Kiln/tests/zip.js in this archive, unchanged below this
 * comment. Kiln wrote it to read Office files; here it reads the zips the
 * extension writes, so a test can assert on what is actually in the archive.
 */

"use strict";

// A minimal ZIP reader, so the tests can assert on what is actually inside a
// .docx/.xlsx/.pptx rather than on its length. Office files are ZIP archives;
// checking the first two bytes are "PK" only proves a zip came out, not that
// it contains the document the script asked for.
//
// This reads the central directory (the authoritative index at the end of the
// file) rather than scanning local headers, and inflates each entry with
// zlib. Only stored (0) and deflated (8) entries appear in Office files.

const zlib = require("zlib");

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

function findEndOfCentralDirectory(buf) {
  // The EOCD record is at the end, but a trailing comment of up to 64 KB may
  // follow it, so scan backwards for the signature.
  const lowest = Math.max(0, buf.length - 0x10000 - 22);
  for (let i = buf.length - 22; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error("not a zip file: no end-of-central-directory record");
}

// Returns { entryName: Buffer } for every file in the archive.
function readZip(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error("readZip expects a Buffer");
  const eocd = findEndOfCentralDirectory(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  const files = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CD_SIG) {
      throw new Error(`corrupt central directory at entry ${i}`);
    }
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    // The local header repeats the name and extra field, and its extra field
    // length can differ from the central one, so read it rather than assume.
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) files[name] = Buffer.from(raw);
    else if (method === 8) files[name] = zlib.inflateRawSync(raw);
    else throw new Error(`unsupported compression method ${method} for ${name}`);

    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// Convenience: the text of one entry, or "" when it is not in the archive.
function entryText(files, name) {
  return files[name] ? files[name].toString("utf8") : "";
}

module.exports = { readZip, entryText };
