import os
import re
from pyrogram import Client, filters
from pyrogram.types import Message
from dotenv import load_dotenv
import yt_dlp

# --- تنظیمات ---
load_dotenv()

API_ID = int(os.getenv("API_ID"))
API_HASH = os.getenv("API_HASH")
BOT_TOKEN = os.getenv("BOT_TOKEN")

app = Client("my_bot", api_id=API_ID, api_hash=API_HASH, bot_token=BOT_TOKEN)


# الگوی تشخیص لینک یوتیوب
YT_REGEX = re.compile(
    r"(?:https?://)?(?:www\.)?"
    r"(?:youtube\.com/(?:watch\?v=|shorts/|embed/|live/|playlist\?list=)"
    r"|youtu\.be/)"
    r"[\w\-]+(?:\?[\w\-&=]*)?",
    re.IGNORECASE,
)


# تنظیمات yt-dlp
YDL_OPTS = {
    "format": "best",
    "quiet": True,
    "no_warnings": True,
    "extract_flat": False,
}


def get_download_info(url: str) -> dict | None:
    """
    لینک یوتیوب را می‌گیرد و اطلاعات دانلود برمی‌گرداند.
    شامل: عنوان، فرمت، حجم و لینک مستقیم.
    """
    try:
        with yt_dlp.YoutubeDL(YDL_OPTS) as ydl:
            info = ydl.extract_info(url, download=False)
            return {
                "title": info.get("title", "بدون عنوان"),
                "url": info.get("url"),
                "ext": info.get("ext", "unknown"),
                "filesize": info.get("filesize") or info.get("filesize_approx", 0),
                "duration": info.get("duration", 0),
                "thumbnail": info.get("thumbnail", ""),
            }
    except Exception as e:
        print(f"Error: {e}")
        return None


def format_size(size_bytes: int) -> str:
    """تبدیل بایت به فرمت خوانا (MB / GB)"""
    if size_bytes >= 1_073_741_824:
        return f"{size_bytes / 1_073_741_824:.1f} GB"
    elif size_bytes >= 1_048_576:
        return f"{size_bytes / 1_048_576:.1f} MB"
    elif size_bytes > 0:
        return f"{size_bytes / 1_024:.1f} KB"
    return "نامشخص"


def format_duration(seconds: int) -> str:
    """تبدیل ثانیه به فرمت ساعت:دقیقه:ثانیه"""
    if not seconds:
        return "نامشخص"
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


@app.on_message(filters.command("start"))
async def start(client: Client, message: Message):
    await message.reply_text(
        "سلام! \n"
        "من می‌توانم لینک یوتیوب را به لینک دانلود مستقیم تبدیل کنم.\n\n"
        "فرمت‌های پشتیبانی:\n"
        "  - ویدیو معمولی\n"
        "  - یوتیوب شورتس\n"
        "  - ویدیوی زنده (بعد از پایان)\n"
        "  - پلی‌لیست\n\n"
        "فقط لینک یوتیوب را بفرستید."
    )


@app.on_message(filters.text & filters.private)
async def downloader(client: Client, message: Message):
    text = message.text.strip()
    match = YT_REGEX.search(text)

    if not match:
        return

    url = match.group(0)
    msg = await message.reply_text("در حال پردازش...\nلطفاً صبر کنید.")

    info = get_download_info(url)

    if not info or not info["url"]:
        await msg.edit("لطفاً دوباره تلاش کنید.")
        return

    size_str = format_size(info["filesize"])
    duration_str = format_duration(info["duration"])

    response = (
        f"{info['title']}\n\n"
        f"فرمت: {info['ext'].upper()}\n"
        f"مدت: {duration_str}\n"
        f"حجم: {size_str}\n\n"
        f"لینک دانلود:\n{info['url']}"
    )

    await msg.edit(response)


print("در حال اجرای ربات...")
app.run()
