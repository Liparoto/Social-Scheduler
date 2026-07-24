// dashboard/scripts/upload-smoke.mjs — run: node dashboard/scripts/upload-smoke.mjs
// Requires the dev server running on :3939. Uploads two crafted images through
// /api/assets/upload and prints the resulting asset rows so a human can eyeball
// conform_mode / needs_review / publish_path. Does NOT clean up on its own —
// delete the returned asset ids (rows + files under data/assets) after checking.
import sharp from "sharp";

const BASE = process.env.SMOKE_BASE_URL || "http://localhost:3939";

async function mkJpeg(w, h) {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: 90, g: 140, b: 200 } },
  })
    .jpeg()
    .toBuffer();
}

async function upload(name, buf) {
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "image/jpeg" }), name);
  const res = await fetch(`${BASE}/api/assets/upload`, { method: "POST", body: form });
  const json = await res.json();
  if (!res.ok) throw new Error(`upload ${name} failed: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const inRange = await mkJpeg(1200, 1200);
const wide = await mkJpeg(3000, 1000);

const r1 = await upload("smoke-inrange.jpg", inRange);
console.log("in-range asset:", JSON.stringify(r1.asset, null, 2));

const r2 = await upload("smoke-wide.jpg", wide);
console.log("wide asset:", JSON.stringify(r2.asset, null, 2));

console.log("\nUploaded asset ids:", r1.asset.id, r2.asset.id);
console.log("Remember to delete these rows + their files under data/assets when done.");
