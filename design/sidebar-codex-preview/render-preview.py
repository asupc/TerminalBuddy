from pathlib import Path
import base64
import io
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).parent
SOURCE = Path(r"C:\Users\WIGGIN~1.WAN\AppData\Local\Temp\codex-clipboard-9e23b1f4-63ac-4d07-9777-4c8d3d9cf084.png")
SCALE = 3
WIDTH, HEIGHT = 376, 926
BG, TEXT, MUTED = "#202123", "#e5e6e8", "#a6a8ad"
canvas = Image.new("RGB", (WIDTH * SCALE, HEIGHT * SCALE), BG)
draw = ImageDraw.Draw(canvas)

def box(bounds, fill, radius=0, outline=None):
    draw.rounded_rectangle(tuple(round(v * SCALE) for v in bounds), radius=radius * SCALE, fill=fill, outline=outline, width=SCALE)

def line(points, color=MUTED, width=1.4):
    draw.line([(round(x * SCALE), round(y * SCALE)) for x, y in points], fill=color, width=round(width * SCALE), joint="curve")

def text(x, y, value, size=14, color=TEXT, bold=False):
    font = ImageFont.truetype(r"C:\Windows\Fonts\msyhbd.ttc" if bold else r"C:\Windows\Fonts\msyh.ttc", round(size * SCALE))
    draw.text((x * SCALE, y * SCALE), value, fill=color, font=font)

def chevron(x, y, expanded=False, color=MUTED):
    if expanded:
        line([(x, y + 2), (x + 4, y + 6), (x + 8, y + 2)], color, 1.2)
    else:
        line([(x + 2, y), (x + 6, y + 4), (x + 2, y + 8)], color, 1.2)

def folder(x, y, opened=False):
    line([(x + 1, y + 12), (x + 1, y + 2), (x + 5, y + 2), (x + 7, y + 4), (x + 15, y + 4), (x + 15, y + 13), (x + 2, y + 13), (x + 1, y + 12)], "#bfc3ca", 1.25)
    if opened:
        line([(x + 2, y + 13), (x + 4, y + 7), (x + 17, y + 7), (x + 15, y + 13)], "#bfc3ca", 1.25)

text(22, 22, "项目与任务", 17, bold=True)
text(126, 27, "7", 12, MUTED)
line([(312, 27), (312, 37)], "#b2b5bc")
line([(307, 32), (317, 32)], "#b2b5bc")
text(324, 23, "项目", 12, MUTED)
box((18, 72, 357, 110), "#27292c", 8, "#35373b")
draw.ellipse((30 * SCALE, 85 * SCALE, 40 * SCALE, 95 * SCALE), outline="#9b9da2", width=round(1.3 * SCALE))
line([(39, 94), (44, 99)], "#9b9da2", 1.3)
text(54, 81, "搜索项目、配置或会话", 13, "#9b9da2")
text(23, 143, "置顶", 13, MUTED)
chevron(59, 149)
text(23, 199, "项目", 13, MUTED)
text(337, 202, "7", 11, "#92959b")
box((12, 232, 363, 274), "#2b2d31", 8)
folder(24, 246, True)
text(52, 241, "服务器工作区", 15)
text(316, 245, "1", 12, "#a5a8af")
chevron(340, 249, True)
line([(33, 283), (33, 360)], "#3a3c41", 1)
line([(47, 295), (62, 295)], "#afb2b8", 1)
line([(47, 301), (62, 301)], "#afb2b8", 1)
line([(51, 291), (51, 298)], "#afb2b8", 1.4)
line([(58, 298), (58, 305)], "#afb2b8", 1.4)
text(72, 287, "配置", 13, "#aeb0b6")
text(315, 291, "2", 11, "#a5a8af")
chevron(339, 294)
box((44, 320, 363, 358), "#2b3744", 7)
box((56, 331, 72, 344), "#2b3744", 2, "#bdd4f0")
line([(60, 335), (63, 338), (60, 341)], "#bdd4f0", 1)
line([(66, 341), (69, 341)], "#bdd4f0", 1)
draw.ellipse((70 * SCALE, 341 * SCALE, 75 * SCALE, 346 * SCALE), fill="#83c69c")
text(84, 328, "mstsc 是啥命令", 13, "#e5edf7")
text(307, 332, "Codex", 10, "#a7bdd6")
projects = [("hongguoSign", "1"), ("hongguoTV", "3"), ("huluwa", ""), ("openhongguo", "2"), ("sub2Api", ""), ("TerminalBuddy", "")]
for index, (name, count) in enumerate(projects):
    y = 376 + index * 44
    folder(24, y + 6)
    text(52, y, name, 15)
    if count:
        text(316, y + 4, count, 12, "#a5a8af")
    chevron(340, y + 8)
text(23, 886, "7 个项目  ·  7 个已打开会话", 11, "#9b9da2")
line([(375, 0), (375, 926)], "#303236", 1)
sidebar = canvas.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)
sidebar.save(ROOT / "sidebar-detail.png")
source = Image.open(SOURCE).convert("RGB")
assert source.size == (1732, 1000), source.size
preview = source.copy()
preview.paste(sidebar, (0, 44))
preview.save(ROOT / "sidebar-preview.png")
terminal = source.crop((376, 44, 1732, 970))
buffer = io.BytesIO()
terminal.save(buffer, format="WEBP", lossless=True)
data_uri = "data:image/webp;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
html_path = ROOT / "sidebar-preview.html"
html = html_path.read_text(encoding="utf-8")
if "@@TERMINAL_REFERENCE@@" in html:
    html_path.write_text(html.replace("@@TERMINAL_REFERENCE@@", data_uri), encoding="utf-8")
print("设计稿已生成：", preview.size, "；侧栏：", sidebar.size)
print("交互稿大小：", html_path.stat().st_size, "字节")
assert html_path.stat().st_size < 1_000_000
assert preview.crop((376, 0, 1732, 1000)).tobytes() == source.crop((376, 0, 1732, 1000)).tobytes()
print("右侧终端像素一致性检查通过")
