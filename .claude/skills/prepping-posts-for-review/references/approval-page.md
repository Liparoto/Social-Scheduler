# The plan file and the approval page

One plan file is the source of truth for a batch. The page the owner approves, the manifest
the importer reads and the tags applied afterwards are all generated from it, so what was
approved and what lands in the library cannot drift apart. Never hand-write a manifest.

## Plan format

```json
{
  "batch": "bali-2026",
  "photos_dir": "/Users/you/Desktop/Bali",
  "posts": [
    {
      "files": ["IMG_3375.jpg", "IMG_3377.jpg"],
      "caption": "The body of the caption, no hashtags here",
      "hashtags": ["#RiceTerraces", "#Ubud", "#TravelDiary"],
      "tags": ["Travel", "Nature"],
      "time_of_day": "anytime",
      "green_periods": [],
      "question": "Is this the Ubud villa or the one in Canggu?",
      "note": "optional note shown to the reviewer"
    }
  ],
  "label": "Bali",
  "round": 1,
  "ref_prefix": "B",
  "credit": "📸 @photographer",
  "channels": [1, 2, 4],
  "channels_label": "Instagram · Threads · Facebook",
  "excluded": {"IMG_3380.jpg": "near-duplicate of IMG_3377.jpg"}
}
```

**Required:** `batch`, `photos_dir`, `posts`, and on each post `files` and `caption`.
Everything else is optional, but `hashtags`, `tags`, `time_of_day` and `round` should be
there in practice.

| Field | What it does |
|---|---|
| `files` | Carousel order **is** this order; the first photo is the cover. |
| `caption` | Body only. The credit and hashtags are appended when the caption is composed, so they are never doubled up. |
| `hashtags` | Go in the caption. Different from `tags`. |
| `tags` | Library topic tags (plain words) used for filtering and autofill. |
| `time_of_day` | `morning`, `afternoon`, `evening` or `anytime`. |
| `green_periods` | **Restricts** the post to that season. Leave empty unless the photo only makes sense then — a Summer window means it waits until June. |
| `question` | Shown as a "Question for you" block on that post and counted in the header. Use it instead of guessing. |
| `note` | Context for the reviewer; not published. |
| `label` | Batch name shown on the page. Defaults to `batch`. |
| `round` | Bump on every rebuild after feedback. Drives the snapshot filename and the edit-highlight colour. |
| `ref_prefix` | Post refs become `B-01`, `B-02`. Defaults to `P`. |
| `credit` | Appended to every caption in the batch. Omit when there is no photographer. |
| `channels` | Target channel ids, shown on the page and used in the import command the builder prints. |
| `channels_label` | How to name those channels to a human. |
| `excluded` | `{"file.jpg": "why"}` — deliberately not used. |

## Building

```bash
BATCH=bali-2026
PLAN="data/import-work/$BATCH/plan.json"

# structure only, instant — use while drafting
.venv/bin/python scripts/build_approval_page.py "$PLAN" --out-dir "data/import-work/$BATCH" --no-previews

# the real page
.venv/bin/python scripts/build_approval_page.py "$PLAN" --out-dir "data/import-work/$BATCH"

# later rounds: badge what changed and highlight the edits they asked for
.venv/bin/python scripts/build_approval_page.py "$PLAN" --out-dir "data/import-work/$BATCH" \
    --previous "data/import-work/$BATCH/plan-round-1.json"
```

`--no-previews` never overwrites an existing round snapshot, so a quick structure check after
the page has been sent cannot destroy the record of what the owner saw.

**It refuses to build** when a photo is used twice, a caption is empty, a carousel is over 10
slides, a file is missing or of a type the importer cannot upload, or two posts carry an
identical hashtag set.

**It prints `CHECK:` lines** — a photo in the folder that is in no post, a carousel mixing
portrait and landscape, a hashtag on more than half the batch. These do not stop the build,
so read the output.

The one thing no tool can check: whether the caption matches the photo. Look at the sheets.

## Checking the page yourself

Without opening a browser — this is also how you confirm rotated photos came out upright:

```bash
.venv/bin/python - <<'PY'
import base64, io, re
from PIL import Image
html = open("data/import-work/<batch>/approval.html", encoding="utf-8").read()
uris = re.findall(r'data:image/jpeg;base64,([^"]+)', html)
print(len(uris), "previews")
for u in uris[:5]:
    im = Image.open(io.BytesIO(base64.b64decode(u)))
    print(im.size, "portrait" if im.height > im.width else "landscape")
PY
```

To view it: send `approval.html` to the owner — it is self-contained and opens anywhere. If
you want to look yourself and your browser tooling refuses `file://` URLs, copy it somewhere
disposable and serve that folder over localhost — never serve `data/`, which holds the
database and its live access tokens:

```bash
python3 -m http.server 3956 --bind 127.0.0.1 --directory <a copy, not data/>
```

## Reading feedback

Owners refer to posts by ref ("P-12 needs a different caption") and to photos by the number
shown under each one ("make 3. M0124 first"). Apply every note to the plan, then let the
rebuild prove it landed: the `--previous` diff labels each post with where it came from, so a
note applied to the wrong post shows up as a badge in the wrong place.
