import { TOKEN, TELEGRAM_API } from '../config.js';

// الگوی تشخیص لینک یوتیوب
const YT_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/|playlist\?list=)|youtu\.be\/)[\w\-]+(?:\?[\w\-&=]*)?/i;

export default async function handler(req, res) {
    // هلت چک — برای UptimeRobot
    if (req.method === 'GET') return res.status(200).send('alive');
    if (req.method !== 'POST') return res.status(405).send('no');

    try {
        const update = req.body;
        const message = update.message;
        if (!message) return res.status(200).send('ok');

        const chatId = message.chat.id;
        const text = message.text || '';

        // دستور /start
        if (text === '/start') {
            await sendMsg(chatId,
                'سلام! \n' +
                'من می‌توانم لینک یوتیوب را به لینک دانلود مستقیم تبدیل کنم.\n\n' +
                'فرمت‌های پشتیبانی:\n' +
                '  - ویدیو معمولی\n' +
                '  - یوتیوب شورتس\n' +
                '  - ویدیوی زنده (بعد از پایان)\n\n' +
                'فقط لینک یوتیوب را بفرستید.'
            );
            return res.status(200).send('ok');
        }

        // بررسی لینک یوتیوب
        const match = text.match(YT_REGEX);
        if (!match) return res.status(200).send('ok');

        const url = match[0];

        // پیام در حال پردازش
        const proc = await sendMsg(chatId, 'در حال پردازش...\nلطفاً صبر کنید.');

        // گرفتن لینک دانلود
        const downloadUrl = await getDownloadLink(url);

        if (downloadUrl) {
            await editMsg(chatId, proc.message_id,
                'لینک دانلود:\n' + downloadUrl
            );
        } else {
            await editMsg(chatId, proc.message_id,
                'لطفاً دوباره تلاش کنید.'
            );
        }

        res.status(200).send('ok');
    } catch (err) {
        console.error('Error:', err);
        res.status(200).send('ok');
    }
}

// ارسال پیام
async function sendMsg(chatId, text) {
    const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
    });
    return r.json();
}

// ویرایش پیام
async function editMsg(chatId, msgId, text) {
    await fetch(`${TELEGRAM_API}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: msgId, text }),
    });
}

// API کوبالت برای دریافت لینک دانلود
async function getDownloadLink(url) {
    try {
        const r = await fetch('https://api.cobalt.tools/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'ytbot/1.0',
            },
            body: JSON.stringify({ url }),
        });
        const data = await r.json();
        return data.url || null;
    } catch {
        return null;
    }
}
