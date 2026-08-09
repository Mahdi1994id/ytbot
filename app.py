import os
import re
import logging
from flask import Flask, request
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
from dotenv import load_dotenv
import yt_dlp

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN")
PORT = int(os.environ.get("PORT", 7860))

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

flask_app = Flask(__name__)

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
        logger.error(f"Error: {e}")
        return None


def format_size(size_bytes: int) -> str:
    if size_bytes >= 1_073_741_824:
        return f"{size_bytes / 1_073_741_824:.1f} GB"
    elif size_bytes >= 1_048_576:
        return f"{size_bytes / 1_048_576:.1f} MB"
    elif size_bytes > 0:
        return f"{size_bytes / 1_024:.1f} KB"
    return "نامشخص"


def format_duration(seconds: int) -> str:
    if not seconds:
        return "نامشخص"
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "سلام! \n"
        "من می‌توانم لینک یوتیوب را به لینک دانلود مستقیم تبدیل کنم.\n\n"
        "فرمت‌های پشتیبانی:\n"
        "  - ویدیو معمولی\n"
        "  - یوتیوب شورتس\n"
        "  - ویدیوی زنده (بعد از پایان)\n"
        "  - پلی‌لیست\n\n"
        "فقط لینک یوتیوب را بفرستید."
    )


async def downloader(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text.strip()
    match = YT_REGEX.search(text)

    if not match:
        return

    url = match.group(0)
    msg = await update.message.reply_text("در حال پردازش...\nلطفاً صبر کنید.")

    info = get_download_info(url)

    if not info or not info["url"]:
        await msg.edit_text("لطفاً دوباره تلاش کنید.")
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

    await msg.edit_text(response)


# ساخت اپلیکیشن تلگرام
telegram_app = Application.builder().token(BOT_TOKEN).build()
telegram_app.add_handler(CommandHandler("start", start))
telegram_app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, downloader))


@flask_app.route(f"/webhook/{BOT_TOKEN}", methods=["POST"])
async def webhook():
    update = Update.de_json(request.get_json(), telegram_app.bot)
    await telegram_app.process_update(update)
    return "ok"


@flask_app.route("/health")
def health():
    return "alive", 200


if __name__ == "__main__":
    # تنظیم وب‌هوک
    import asyncio
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    space_url = os.environ.get("SPACE_URL", "")
    if space_url:
        webhook_url = f"{space_url}/webhook/{BOT_TOKEN}"
        loop.run_until_complete(telegram_app.bot.set_webhook(webhook_url))
        logger.info(f"Webhook set: {webhook_url}")
    else:
        logger.warning("SPACE_URL not set, skipping webhook setup")

    from hypercorn.asyncio import serve
    from hypercorn.config import Config

    config = Config()
    config.bind = [f"0.0.0.0:{PORT}"]

    loop.run_until_complete(serve(flask_app, config))
