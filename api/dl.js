// YouTube video proxy - Node.js Runtime (NOT Edge)
// Fast strategy: Piped Proxy (3s timeout, 2 instances) → Piped googlevideo → 403 fallback

import { RAPIDAPI_KEY } from '../config.js';

// Only use the fastest/most reliable Piped instances
const PIPED_INSTANCES = [
    'api.piped.private.coffee',
    'pipedapi.r4fo.xyz',
];

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const videoId = req.query?.v || null;
    const directUrl = req.query?.url || null;

    if (!videoId && !directUrl) {
        return res.status(400).json({ error: 'Missing v or url parameter' });
    }

    const fetchOptions = {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
    };
    if (req.headers.range) {
        fetchOptions.headers.Range = req.headers.range;
    }

    // If direct URL, just stream it
    if (directUrl) {
        return await tryStream(res, directUrl, fetchOptions, 'direct');
    }

    // If video ID, try strategies (FAST — must complete within 8s for Vercel hobby)
    if (videoId) {
        // Strategy 1: Piped Proxy URL (no IP-lock, fast)
        const pipedProxyUrl = await getPipedProxyUrl(videoId);
        if (pipedProxyUrl) {
            const result = await tryStream(res, pipedProxyUrl, fetchOptions, 'piped-proxy');
            if (result !== 'fail') return;
            console.log('Piped proxy failed, trying googlevideo...');
        }

        // Strategy 2: Piped googlevideo URL (may work from Vercel IP)
        const pipedGvUrl = await getPipedGooglevideoUrl(videoId);
        if (pipedGvUrl) {
            const result = await tryStream(res, pipedGvUrl, fetchOptions, 'piped-gv');
            if (result !== 'fail') return;
        }

        // All strategies failed
        return res.status(403).json({ error: 'Download failed — YouTube is blocking server-side access. Try again later or use a different video.', videoId });
    }

    return res.status(400).json({ error: 'Invalid request' });
}

async function tryStream(res, url, fetchOptions, source) {
    try {
        const videoResp = await fetch(url, { ...fetchOptions, redirect: 'follow' });
        if (videoResp.ok) {
            console.log(`Streaming from ${source}:`, url.substring(0, 80) + '...');
            return streamResponse(res, videoResp);
        }
        console.error(`Fetch failed from ${source}:`, videoResp.status);
        return 'fail';
    } catch (e) {
        console.error(`Stream err from ${source}:`, e.message);
        return 'fail';
    }
}

function streamResponse(res, videoResp) {
    const contentType = videoResp.headers.get('Content-Type') || 'video/mp4';
    res.setHeader('Content-Type', contentType);

    const contentLength = videoResp.headers.get('Content-Length');
    const contentRange = videoResp.headers.get('Content-Range');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    if (contentRange) res.setHeader('Content-Range', contentRange);
    res.setHeader('Accept-Ranges', 'bytes');

    const status = contentRange ? 206 : 200;
    res.status(status);

    return videoResp.body.pipeTo
        ? videoResp.body.pipeTo(new WritableStream({
              write(chunk) { res.write(Buffer.from(chunk)); },
              close() { res.end(); },
          }))
        : videoResp.arrayBuffer().then(buf => {
              res.end(Buffer.from(buf));
          });
}

// ─── Piped Proxy URL (fast — 3s timeout per instance) ───
async function getPipedProxyUrl(videoId) {
    for (const instance of PIPED_INSTANCES) {
        try {
            const r = await fetch(`https://${instance}/streams/${videoId}`, {
                signal: AbortSignal.timeout(3000),
                headers: { 'User-Agent': 'Mozilla/5.0' },
                redirect: 'follow',
            });
            if (!r.ok) continue;

            const data = await r.json();
            const allStreams = [...(data.videoStreams || []), ...(data.audioStreams || [])];
            const proxyStream = allStreams.find(s => s.url && s.url.includes('/proxy.'));
            if (proxyStream) return proxyStream.url;

        } catch (e) {
            console.error(`Piped ${instance} err:`, e.message);
        }
    }
    return null;
}

// ─── Piped googlevideo URL ───
async function getPipedGooglevideoUrl(videoId) {
    for (const instance of PIPED_INSTANCES) {
        try {
            const r = await fetch(`https://${instance}/streams/${videoId}`, {
                signal: AbortSignal.timeout(3000),
                headers: { 'User-Agent': 'Mozilla/5.0' },
                redirect: 'follow',
            });
            if (!r.ok) continue;

            const data = await r.json();
            const videoStreams = (data.videoStreams || [])
                .filter(s => s.url && s.url.includes('googlevideo'))
                .sort((a, b) => (b.height || 0) - (a.height || 0));

            if (videoStreams.length > 0) return videoStreams[0].url;

        } catch (e) {
            console.error(`Piped GV ${instance} err:`, e.message);
        }
    }
    return null;
}
