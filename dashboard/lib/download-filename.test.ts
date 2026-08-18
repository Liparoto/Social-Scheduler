/**
 * Naming a downloaded asset.
 *
 * The interesting cases are all hostile or degenerate inputs: `original_filename` is
 * whatever the uploading browser claimed, and it lands directly in an HTTP header. A
 * newline there splits the response; a quote ends the header value early. The rest is
 * making sure a real download still arrives with a name a person recognises.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { contentDisposition, downloadFilename } from "./download-filename.ts";

test("an ordinary uploaded name is used as-is", () => {
  assert.equal(downloadFilename("beach-day.jpg", 42, "ab/cd/a3f9.jpg"), "beach-day.jpg");
});

test("a missing original name falls back to the id, keeping the stored extension", () => {
  assert.equal(downloadFilename(null, 42, "ab/cd/a3f9.jpg"), "asset-42.jpg");
  assert.equal(downloadFilename(undefined, 7, "ab/cd/a3f9.mp4"), "asset-7.mp4");
});

test("an empty or whitespace-only name falls back rather than producing a nameless file", () => {
  assert.equal(downloadFilename("", 42, "ab/a3f9.jpg"), "asset-42.jpg");
  assert.equal(downloadFilename("   ", 42, "ab/a3f9.jpg"), "asset-42.jpg");
});

test("directory components are stripped, whatever the separator", () => {
  assert.equal(downloadFilename("../../etc/passwd.jpg", 1, "a.jpg"), "passwd.jpg");
  assert.equal(downloadFilename("C:\\Users\\kelan\\shot.png", 1, "a.jpg"), "shot.png");
  assert.equal(downloadFilename("/absolute/path/pic.jpg", 1, "a.jpg"), "pic.jpg");
});

test("a name that is only dots cannot become the filename", () => {
  assert.equal(downloadFilename("..", 9, "a.jpg"), "asset-9.jpg");
  assert.equal(downloadFilename(".", 9, "a.jpg"), "asset-9.jpg");
});

test("control characters and quotes are removed — these would corrupt the header", () => {
  // A CRLF here is response splitting, not a cosmetic problem.
  assert.equal(downloadFilename("evil\r\nX-Injected: 1.jpg", 1, "a.jpg"), "evilX-Injected: 1.jpg");
  assert.equal(downloadFilename('say "hi".jpg', 1, "a.jpg"), "say hi.jpg");
  assert.equal(downloadFilename("tab\there.jpg", 1, "a.jpg"), "tabhere.jpg");
});

test("a name with no extension borrows the stored file's", () => {
  assert.equal(downloadFilename("holiday", 1, "ab/cd/a3f9.png"), "holiday.png");
});

test("a dotfile-looking name is not mistaken for a bare extension", () => {
  // ".jpg" has its dot at index 0, so it is a name without an extension, not an
  // extension without a name — it should gain the stored one rather than keep only itself.
  assert.equal(downloadFilename(".jpg", 1, "ab/a3f9.png"), ".jpg.png");
});

test("a stored path with no extension still yields a usable fallback", () => {
  assert.equal(downloadFilename(null, 5, "ab/cd/a3f9"), "asset-5");
});

test("emoji and accents survive into the RFC 5987 parameter", () => {
  const header = contentDisposition("café 🎉.jpg");
  // The real name, percent-encoded, is what browsers actually use.
  assert.match(header, /filename\*=UTF-8''caf%C3%A9%20%F0%9F%8E%89\.jpg$/);
  // The legacy ASCII parameter degrades rather than emitting raw high bytes.
  assert.match(header, /filename="caf_ __\.jpg"/);
});

test("the header always declares an attachment", () => {
  assert.match(contentDisposition("beach-day.jpg"), /^attachment; /);
});

test("a quote reaching contentDisposition directly cannot close the quoted string", () => {
  // Defence in depth: downloadFilename already strips these, but contentDisposition is
  // exported separately and must not depend on its caller having sanitized first.
  assert.ok(!contentDisposition('a"b.jpg').includes('"a"b.jpg"'));
});
