"""Generate the tiny inline avatar used by the settings page's "leave a Star" button.

The client bundle has no asset route, so the picture is inlined as a data URL.
64x64 is plenty: it renders at about one character's height (1em).
"""
from PIL import Image
import base64
import io
import pathlib

SRC = pathlib.Path(
    r"C:\Users\李劲翔666\.dsh\attachments\v1\objects\37"
    r"\37557fb2762cc0699d8b60eaf184eb910b5bc708e572df50270ccbcca80b2ce7"
)
OUT = pathlib.Path(
    r"D:\dsh-ws\dsh-persona-switch\dsh-persona-switcher\src\client\star-avatar.js"
)

img = Image.open(SRC).convert("RGBA")
side = min(img.size)
left = (img.width - side) // 2
top = (img.height - side) // 2
img = img.crop((left, top, left + side, top + side)).resize((64, 64), Image.LANCZOS)
# A palette keeps the base64 short; nothing here needs true colour.
img = img.convert("RGB").quantize(colors=96, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG)

buf = io.BytesIO()
img.save(buf, format="PNG", optimize=True)
data = base64.b64encode(buf.getvalue()).decode()

OUT.write_text(
    "// A tiny avatar for the \"leave a Star\" button at the bottom of the settings\n"
    "// page. Generated from the role artwork at 64x64 (renders at about one\n"
    "// character's height) and inlined as a data URL because the client bundle has\n"
    "// no asset route of its own. Rebuild with scripts/make-star-avatar.py.\n"
    f"export const STAR_AVATAR = 'data:image/png;base64,{data}'\n",
    encoding="utf-8",
)
print(f"png bytes: {len(buf.getvalue())}  base64 chars: {len(data)}  -> {OUT}")
