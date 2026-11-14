"""Хвиля — особистий музичний стрімінг поверх YouTube Music.

Бекенд: пошук / рекомендації (ytmusicapi), аудіо (yt-dlp) з дисковим кешем
і попереднім завантаженням, щоб перемикання треків було миттєвим.
"""
from __future__ import annotations

import asyncio
import ipaddress
import secrets
import subprocess
import sys
import json
import os
import re
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx
import yt_dlp
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from ytmusicapi import YTMusic

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
DATA = ROOT / "data"
AUDIO = DATA / "audio"
AUDIO.mkdir(parents=True, exist_ok=True)
STATE_FILE = DATA / "library.json"
CACHE_LIMIT = int(os.environ.get("CACHE_MB", "2000")) * 1024 * 1024
CHUNK = 8 * 1024 * 1024  # googlevideo віддає максимум ~10 МБ за запит
LOCATION = os.environ.get("YTM_LOCATION", "UA")
VID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
PAGES_URL = os.environ.get("PAGES_URL", "https://nazya-why.github.io/hvylia/")
PAGES_ORIGIN = "{0.scheme}://{0.netloc}".format(urlparse(PAGES_URL))

# Ключ доступу: потрібен для всіх запитів, що приходять не з локальної мережі (через тунель).
KEY_FILE = DATA / "key.txt"
if not KEY_FILE.exists():
    KEY_FILE.write_text(secrets.token_urlsafe(18), "utf-8")
KEY = KEY_FILE.read_text("utf-8").strip()

api_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="ytm")
hi_pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="dl-hi")  # те, що грає зараз
lo_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="dl-lo")  # попереднє завантаження

_tls = threading.local()


class YTM(YTMusic):
    """Обхід: YT Music інколи додає на сторінку артиста промо-карусель без заголовка,
    через яку ytmusicapi губить «Популярні» або падає. Прибираємо її з відповіді."""

    def _send_request(self, endpoint, body, *args, **kwargs):
        r = super()._send_request(endpoint, body, *args, **kwargs)
        if endpoint == "browse" and str(body.get("browseId", "")).startswith("UC"):
            for path in (("singleColumnBrowseResultsRenderer",), ("twoColumnBrowseResultsRenderer",)):
                try:
                    sl = r["contents"][path[0]]["tabs"][0]["tabRenderer"]["content"]["sectionListRenderer"]
                    sl["contents"] = [x for x in sl["contents"] if "musicCarouselShelfRenderer" not in x or "header" in x["musicCarouselShelfRenderer"]]
                except (KeyError, IndexError, TypeError):
                    pass
        return r


def ytm() -> YTMusic:
    yt = getattr(_tls, "yt", None)
    if yt is None:
        yt = _tls.yt = YTM(location=LOCATION)
    return yt


# ───────────────────────── кеш з TTL та дедуплікацією ─────────────────────────
_cache: dict[str, tuple[float, object]] = {}
_inflight: dict[str, asyncio.Future] = {}


async def cached(key: str, ttl: int, fn, *args, pool=api_pool):
    hit = _cache.get(key)
    if hit and hit[0] > time.time():
        return hit[1]
    if key in _inflight:
        return await _inflight[key]
    loop = asyncio.get_running_loop()
    fut = asyncio.ensure_future(loop.run_in_executor(pool, fn, *args))
    _inflight[key] = fut
    try:
        val = await fut
    finally:
        _inflight.pop(key, None)
    _cache[key] = (time.time() + ttl, val)
    if len(_cache) > 3000:
        now = time.time()
        for k in [k for k, v in _cache.items() if v[0] < now]:
            _cache.pop(k, None)
    return val


# ───────────────────────────── нормалізація даних ─────────────────────────────
def _resize(url: str | None, size: int) -> str | None:
    if not url:
        return None
    if "googleusercontent.com" in url or "ggpht.com" in url:
        if re.search(r"=w\d+-h\d+", url):
            return re.sub(r"=w\d+-h\d+[^&]*$", f"=w{size}-h{size}-l90-rj", url)
        if re.search(r"=s\d+", url):
            return re.sub(r"=s\d+[^&]*$", f"=s{size}", url)
        return url + f"=w{size}-h{size}-l90-rj"
    return url


def _thumbs(item: dict, vid: str | None = None, video: bool = False):
    th = item.get("thumbnails") or item.get("thumbnail") or []
    if isinstance(th, dict):
        th = th.get("thumbnails") or []
    url = th[-1]["url"] if th else None
    if vid and (video or not url or "i.ytimg.com" in (url or "")):
        return f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg", f"https://i.ytimg.com/vi/{vid}/maxresdefault.jpg"
    return _resize(url, 180), _resize(url, 720)


def _dur(s) -> int:
    if not s or not isinstance(s, str):
        return 0
    try:
        parts = [int(p) for p in s.split(":")]
    except ValueError:
        return 0
    total = 0
    for p in parts:
        total = total * 60 + p
    return total


def _artists(item: dict):
    out = []
    for a in item.get("artists") or []:
        name = a.get("name")
        if name and not re.match(r"^\d[\d.,]*\s*[KMBТМ]?\s*(views|переглядів|plays)?$", name):
            out.append({"name": name, "id": a.get("id")})
    if not out and item.get("author"):
        au = item["author"]
        if isinstance(au, list):
            out = [{"name": a.get("name"), "id": a.get("id")} for a in au if a.get("name")]
        elif isinstance(au, str):
            out = [{"name": au, "id": None}]
    return out


def track(t: dict, art: tuple | None = None, album: dict | None = None):
    vid = t.get("videoId")
    if not vid:
        return None
    video = t.get("videoType") not in (None, "MUSIC_VIDEO_TYPE_ATV") or t.get("resultType") == "video"
    thumb, big = art if art else _thumbs(t, vid, video)
    alb = t.get("album") or album
    if isinstance(alb, str):
        alb = {"name": alb, "id": None}
    return {
        "id": vid,
        "title": t.get("title") or "Без назви",
        "artists": _artists(t),
        "album": {"name": alb.get("name"), "id": alb.get("id")} if alb and alb.get("name") else None,
        "duration": t.get("duration_seconds") or _dur(t.get("duration") or t.get("length")),
        "thumb": thumb,
        "art": big,
        "explicit": bool(t.get("isExplicit")),
        "video": bool(video),
    }


def album_item(a: dict):
    thumb, big = _thumbs(a)
    return {
        "kind": "album",
        "id": a.get("browseId") or a.get("audioPlaylistId"),
        "title": a.get("title"),
        "subtitle": " • ".join(x for x in [a.get("type") or "Альбом", str(a.get("year") or "")] if x and x != "None"),
        "artists": _artists(a),
        "thumb": thumb,
        "art": big,
    }


def playlist_item(p: dict):
    thumb, big = _thumbs(p)
    pid = p.get("playlistId") or p.get("browseId") or ""
    if pid.startswith("VL"):
        pid = pid[2:]
    author = p.get("author")
    if isinstance(author, list):
        author = ", ".join(a.get("name", "") for a in author)
    sub = p.get("description") or author or ""
    if p.get("itemCount"):
        sub = f"{sub} • {p['itemCount']} треків" if sub else f"{p['itemCount']} треків"
    return {"kind": "playlist", "id": pid, "title": p.get("title"), "subtitle": sub, "thumb": thumb, "art": big}


def artist_item(a: dict):
    thumb, big = _thumbs(a)
    return {
        "kind": "artist",
        "id": a.get("browseId") or a.get("channelId") or a.get("id") or ((a.get("artists") or [{}])[0].get("id")),
        "title": a.get("artist") or a.get("title") or a.get("name") or ((a.get("artists") or [{}])[0].get("name")),
        "subtitle": a.get("subscribers") and f"{a['subscribers']} підписників" or "Виконавець",
        "thumb": thumb,
        "art": big,
    }


def any_item(c: dict):
    if c.get("videoId"):
        t = track(c)
        return t and {"kind": "track", **t}
    bid = c.get("browseId") or ""
    if c.get("playlistId") and not bid.startswith("MPRE"):
        return playlist_item(c)
    if bid.startswith("MPRE"):
        return album_item(c)
    if bid.startswith("UC") or c.get("subscribers"):
        return artist_item(c)
    if bid.startswith("VL"):
        return playlist_item(c)
    return None


def compact(xs):
    return [x for x in xs if x]


# ─────────────────────────────── API: каталог ───────────────────────────────
app = FastAPI(title="Хвиля")
app.add_middleware(GZipMiddleware, minimum_size=800)


def _is_local(request: Request) -> bool:
    if any(h in request.headers for h in ("cf-connecting-ip", "x-forwarded-for", "cf-ray")):
        return False  # прийшло через тунель
    try:
        ip = ipaddress.ip_address(request.client.host if request.client else "0.0.0.0")
        return ip.is_private or ip.is_loopback
    except ValueError:
        return False


@app.middleware("http")
async def guard(request: Request, call_next):
    if request.url.path.startswith("/api/") and request.method != "OPTIONS" and not _is_local(request):
        k = request.query_params.get("k") or request.headers.get("x-key")
        if not k or not secrets.compare_digest(k, KEY):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=[PAGES_ORIGIN, "http://localhost:8000", "http://127.0.0.1:8000"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
    max_age=86400,
)


def J(data, max_age=300):
    return JSONResponse(data, headers={"Cache-Control": f"private, max-age={max_age}"})


@app.get("/api/suggest")
async def suggest(q: str):
    q = q.strip()
    if not q:
        return J([])
    res = await cached(f"sug:{q.lower()}", 3600, lambda: ytm().get_search_suggestions(q))
    return J(res[:8], 3600)


def _search(q: str, flt: str | None, limit: int = 40):
    yt = ytm()
    if flt:
        res = yt.search(q, filter=flt, limit=limit)
        if flt in ("songs", "videos"):
            return {"items": compact(track(r) for r in res)}
        if flt == "albums":
            return {"items": [album_item(r) for r in res]}
        if flt == "artists":
            return {"items": [artist_item(r) for r in res]}
        if flt in ("playlists", "community_playlists", "featured_playlists"):
            return {"items": [playlist_item(r) for r in res]}
    return None


def _top(q: str):
    for r in ytm().search(q, limit=5):
        if r.get("category") in ("Top result", "Найкращий результат"):
            rt = r.get("resultType")
            if rt == "artist":
                it = artist_item(r)
                return it if it["id"] else None
            if rt == "album":
                return album_item(r)
            if rt == "playlist":
                return playlist_item(r)
            if rt in ("song", "video") and r.get("artists"):
                t = track(r)
                return t and {"kind": "track", **t}
    return None


@app.get("/api/search")
async def search(q: str, filter: str | None = None):
    q = q.strip()
    if not q:
        return J({})
    key = q.lower()
    if filter:
        return J(await cached(f"s:{filter}:{key}", 900, _search, q, filter), 900)
    kinds = ("songs", "artists", "albums", "playlists", "videos")
    res = await asyncio.gather(
        cached(f"top:{key}", 900, _top, q),
        *[cached(f"s1:{k}:{key}", 900, _search, q, k, 18) for k in kinds],
        return_exceptions=True,
    )
    top = res[0] if not isinstance(res[0], Exception) else None
    out = {k: ([] if isinstance(r, Exception) else r["items"]) for k, r in zip(kinds, res[1:])}
    out["songs"] = [{"kind": "track", **t} for t in out["songs"]]
    out["videos"] = [{"kind": "track", **t} for t in out["videos"]]
    out["top"] = top or (out["artists"] or out["songs"] or [None])[0]
    return J(out, 900)


def _home():
    sections = []
    for s in ytm().get_home(limit=10):
        items = compact(any_item(c) for c in s.get("contents") or [] if c)
        if items:
            sections.append({"title": s.get("title"), "items": items[:20]})
    return sections


@app.get("/api/home")
async def home():
    return J(await cached("home", 1800, _home), 1800)


def _watch(vid: str, playlist: str | None, radio: bool):
    w = ytm().get_watch_playlist(videoId=vid, playlistId=playlist, radio=radio, limit=50)
    return {"tracks": compact(track(t) for t in w.get("tracks") or []), "lyrics": w.get("lyrics"), "related": w.get("related")}


@app.get("/api/radio/{vid}")
async def radio(vid: str, playlist: str | None = None):
    data = await cached(f"r:{vid}:{playlist}", 1800, _watch, vid, playlist, playlist is None)
    return J(data, 1800)


@app.get("/api/mix")
async def mix(seeds: str):
    ids = [s for s in seeds.split(",") if VID_RE.match(s)][:6]
    if not ids:
        return J({"tracks": []})
    results = await asyncio.gather(*[cached(f"r:{v}:None", 1800, _watch, v, None, True) for v in ids], return_exceptions=True)
    lists = [r["tracks"][1:] for r in results if isinstance(r, dict)]
    seen, out = set(ids), []
    for i in range(max((len(l) for l in lists), default=0)):
        for l in lists:
            if i < len(l) and l[i]["id"] not in seen:
                seen.add(l[i]["id"])
                out.append(l[i])
    return J({"tracks": out[:80]}, 1800)


def _artist(cid: str):
    a = ytm().get_artist(cid)
    thumb, big = _thumbs(a)
    songs = a.get("songs") or {}
    res = {
        "id": cid,
        "name": a.get("name"),
        "description": a.get("description"),
        "subscribers": a.get("subscribers"),
        "views": a.get("views"),
        "thumb": thumb,
        "art": _resize((a.get("thumbnails") or [{}])[-1].get("url"), 1080) or big,
        "songsPlaylist": (songs.get("browseId") or "").removeprefix("VL") or None,
        "songs": compact(track(t) for t in songs.get("results") or []),
        "radio": a.get("radioId"),
        "shuffle": a.get("shuffleId"),
    }
    for key, fn in (("albums", album_item), ("singles", album_item), ("videos", track), ("playlists", playlist_item), ("related", artist_item)):
        block = a.get(key) or {}
        items = compact(fn(x) for x in block.get("results") or [])
        if key == "videos":
            items = [{"kind": "track", **t} for t in items]
        res[key] = items
    return res


@app.get("/api/artist/{cid}")
async def artist(cid: str):
    return J(await cached(f"a:{cid}", 3600, _artist, cid), 3600)


def _album(bid: str):
    a = ytm().get_album(bid)
    art = _thumbs(a)
    meta = {"name": a.get("title"), "id": bid}
    tracks = compact(track(t, art=art, album=meta) for t in a.get("tracks") or [])
    for t in tracks:
        if not t["artists"]:
            t["artists"] = _artists(a)
    return {
        "id": bid,
        "title": a.get("title"),
        "type": a.get("type") or "Альбом",
        "year": a.get("year"),
        "artists": _artists(a),
        "thumb": art[0],
        "art": art[1],
        "duration": a.get("duration"),
        "playlistId": a.get("audioPlaylistId"),
        "tracks": tracks,
    }


@app.get("/api/album/{bid}")
async def album(bid: str):
    return J(await cached(f"al:{bid}", 3600 * 6, _album, bid), 3600)


def _playlist(pid: str):
    p = ytm().get_playlist(pid, limit=300)
    thumb, big = _thumbs(p)
    author = p.get("author")
    if isinstance(author, dict):
        author = author.get("name")
    return {
        "id": pid,
        "title": p.get("title"),
        "author": author,
        "description": p.get("description"),
        "count": p.get("trackCount"),
        "thumb": thumb,
        "art": big,
        "tracks": compact(track(t) for t in p.get("tracks") or []),
    }


@app.get("/api/playlist/{pid}")
async def playlist(pid: str):
    pid = pid.removeprefix("VL")
    return J(await cached(f"pl:{pid}", 1800, _playlist, pid), 1800)


def _lyrics(vid: str):
    w = ytm().get_watch_playlist(videoId=vid, limit=1)
    lid = w.get("lyrics")
    if not lid:
        return None
    yt = ytm()
    try:
        l = yt.get_lyrics(lid, timestamps=True)
    except Exception:
        l = yt.get_lyrics(lid)
    if not l:
        return None
    lines = l.get("lyrics")
    if l.get("hasTimestamps") and isinstance(lines, list):
        return {"synced": True, "lines": [{"t": x.start_time, "text": x.text} for x in lines], "source": l.get("source")}
    return {"synced": False, "text": lines, "source": l.get("source")}


@app.get("/api/lyrics/{vid}")
async def lyrics(vid: str):
    try:
        data = await cached(f"ly:{vid}", 3600 * 24, _lyrics, vid)
    except Exception:
        data = None
    return J(data, 3600)


# ─────────────────────── бібліотека (синхронізація між пристроями) ───────────────────────
@app.get("/api/library")
async def get_library():
    if STATE_FILE.exists():
        return Response(STATE_FILE.read_text("utf-8"), media_type="application/json", headers={"Cache-Control": "no-store"})
    return JSONResponse({"updatedAt": 0}, headers={"Cache-Control": "no-store"})


@app.put("/api/library")
async def put_library(request: Request):
    body = await request.body()
    if len(body) > 10 * 1024 * 1024:
        raise HTTPException(413)
    data = json.loads(body)
    cur = json.loads(STATE_FILE.read_text("utf-8")) if STATE_FILE.exists() else {"updatedAt": 0}
    if data.get("updatedAt", 0) < cur.get("updatedAt", 0):
        return JSONResponse({"ok": False, "stale": True, "updatedAt": cur.get("updatedAt")})
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
    tmp.replace(STATE_FILE)
    return {"ok": True}


# ─────────────────────────────── аудіо ───────────────────────────────
@dataclass
class Stream:
    url: str
    size: int
    expire: float
    mime: str
    ext: str
    headers: dict


_streams: dict[str, Stream] = {}
_resolving: dict[str, asyncio.Future] = {}
_downloads: dict[str, asyncio.Task] = {}
NODE = shutil.which("node")
YDL_OPTS = {
    "format": "bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio",
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "noplaylist": True,
    "cachedir": str(DATA / "yt-dlp"),
}
if NODE:
    YDL_OPTS["js_runtimes"] = {"node": {"path": NODE}}

http: httpx.AsyncClient | None = None


@app.on_event("startup")
async def _startup():
    global http
    # прогріваємо клієнти YTMusic у потоках, щоб перший запит був швидким
    loop = asyncio.get_running_loop()
    for _ in range(8):
        loop.run_in_executor(api_pool, ytm)
    http = httpx.AsyncClient(timeout=httpx.Timeout(20, read=60), follow_redirects=True, http2=False, limits=httpx.Limits(max_connections=40))
    for p in AUDIO.glob("*.part"):
        p.unlink(missing_ok=True)


def _extract(vid: str) -> Stream:
    with yt_dlp.YoutubeDL(YDL_OPTS) as y:
        info = y.extract_info(f"https://www.youtube.com/watch?v={vid}", download=False)
    url = info["url"]
    qs = parse_qs(urlparse(url).query)
    size = int((qs.get("clen") or [0])[0] or 0) or int(info.get("filesize") or 0)
    expire = float((qs.get("expire") or [0])[0] or 0) or time.time() + 3 * 3600
    ext = info.get("ext") or "m4a"
    mime = "audio/mp4" if ext in ("m4a", "mp4") else "audio/webm"
    return Stream(url, size, expire, mime, ext, dict(info.get("http_headers") or {}))


async def resolve(vid: str, urgent=True, fresh=False) -> Stream:
    s = _streams.get(vid)
    if s and not fresh and s.expire - time.time() > 900:
        return s
    if vid in _resolving:
        return await _resolving[vid]
    loop = asyncio.get_running_loop()
    fut = asyncio.ensure_future(loop.run_in_executor(hi_pool if urgent else lo_pool, _extract, vid))
    _resolving[vid] = fut
    try:
        s = await fut
    finally:
        _resolving.pop(vid, None)
    _streams[vid] = s
    return s


def cached_file(vid: str) -> Path | None:
    for ext in ("m4a", "webm"):
        p = AUDIO / f"{vid}.{ext}"
        if p.exists():
            return p
    return None


def _trim_cache():
    files = sorted((p for p in AUDIO.iterdir() if p.suffix in (".m4a", ".webm")), key=lambda p: p.stat().st_mtime)
    total = sum(p.stat().st_size for p in files)
    while files and total > CACHE_LIMIT:
        p = files.pop(0)
        total -= p.stat().st_size
        p.unlink(missing_ok=True)


async def _fetch_range(s: Stream, start: int, end: int):
    headers = {**s.headers, "Range": f"bytes={start}-{end}"}
    req = http.build_request("GET", s.url, headers=headers)
    return await http.send(req, stream=True)


async def _download(vid: str, urgent: bool):
    s = await resolve(vid, urgent)
    for attempt in range(2):
        part = AUDIO / f"{vid}.part"
        try:
            size = s.size
            pos = 0
            with open(part, "wb") as f:
                while not size or pos < size:
                    end = pos + CHUNK - 1 if not size else min(pos + CHUNK, size) - 1
                    r = await _fetch_range(s, pos, end)
                    try:
                        if r.status_code in (403, 410):
                            raise PermissionError
                        if r.status_code == 416:
                            break
                        r.raise_for_status()
                        if not size:
                            cr = r.headers.get("content-range", "")
                            size = int(cr.split("/")[-1]) if "/" in cr and cr.split("/")[-1].isdigit() else 0
                        got = 0
                        async for b in r.aiter_bytes(256 * 1024):
                            f.write(b)
                            got += len(b)
                        pos += got
                        if not got:
                            break
                    finally:
                        await r.aclose()
                    if not size:
                        break
            dest = AUDIO / f"{vid}.{s.ext}"
            part.replace(dest)
            _trim_cache()
            return dest
        except PermissionError:
            part.unlink(missing_ok=True)
            s = await resolve(vid, urgent, fresh=True)
        except Exception:
            part.unlink(missing_ok=True)
            raise
    raise HTTPException(502, "Не вдалося завантажити аудіо")


def ensure_download(vid: str, urgent=False) -> asyncio.Task:
    t = _downloads.get(vid)
    if t and not t.done():
        return t
    t = asyncio.create_task(_download(vid, urgent))
    _downloads[vid] = t
    t.add_done_callback(lambda _t: _downloads.pop(vid, None) if _downloads.get(vid) is _t else None)
    return t


def _check(vid: str):
    if not VID_RE.match(vid):
        raise HTTPException(400, "bad id")


@app.get("/api/stream/{vid}")
async def stream(vid: str, request: Request, full: int = 0):
    _check(vid)
    p = cached_file(vid)
    if not p and full:
        # повний файл для попереднього завантаження на клієнті
        try:
            p = await ensure_download(vid, urgent=False)
        except Exception:
            raise HTTPException(502, "Не вдалося завантажити аудіо")
    if p:
        os.utime(p)
        return FileResponse(p, media_type="audio/mp4" if p.suffix == ".m4a" else "audio/webm", headers={"Cache-Control": "private, max-age=86400"})

    # Ще немає в кеші: проксуємо з YouTube і паралельно кешуємо на диск
    ensure_download(vid, urgent=True)
    s = await resolve(vid, urgent=True)
    rng = request.headers.get("range")
    start, end = 0, (s.size - 1 if s.size else None)
    if rng:
        m = re.match(r"bytes=(\d*)-(\d*)", rng)
        if m:
            if m.group(1):
                start = int(m.group(1))
                if m.group(2):
                    end = min(int(m.group(2)), end) if end is not None else int(m.group(2))
            elif m.group(2) and s.size:
                start = max(0, s.size - int(m.group(2)))
    if s.size and start >= s.size:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{s.size}"})

    first_end = min(start + CHUNK - 1, end) if end is not None else start + CHUNK - 1
    r = await _fetch_range(s, start, first_end)
    if r.status_code in (403, 410):
        await r.aclose()
        s = await resolve(vid, urgent=True, fresh=True)
        r = await _fetch_range(s, start, first_end)
    if r.status_code >= 400:
        await r.aclose()
        raise HTTPException(502, "YouTube відхилив запит")
    if end is None:
        cr = r.headers.get("content-range", "")
        total = cr.split("/")[-1]
        end = int(total) - 1 if total.isdigit() else None

    async def body():
        nonlocal r
        pos = start
        try:
            while True:
                async for b in r.aiter_bytes(128 * 1024):
                    pos += len(b)
                    yield b
                await r.aclose()
                if end is None or pos > end:
                    break
                r = await _fetch_range(s, pos, min(pos + CHUNK - 1, end))
                if r.status_code >= 400:
                    break
        finally:
            await r.aclose()

    headers = {"Accept-Ranges": "bytes", "Cache-Control": "no-store"}
    total_size = s.size or (end + 1 if end is not None else None)
    if end is not None:
        headers["Content-Length"] = str(end - start + 1)
    status = 200
    if rng and total_size:
        status = 206
        headers["Content-Range"] = f"bytes {start}-{end}/{total_size}"
    return StreamingResponse(body(), status_code=status, media_type=s.mime, headers=headers)


def _quiet(f):
    if not f.cancelled():
        f.exception()


@app.post("/api/prefetch")
async def prefetch(ids: str, mode: str = "download"):
    """mode=download — повністю кешувати; mode=resolve — лише отримати посилання."""
    vids = [v for v in ids.split(",") if VID_RE.match(v)][:6]
    for v in vids:
        if cached_file(v):
            continue
        if mode == "resolve":
            if v not in _streams and v not in _resolving:
                asyncio.ensure_future(resolve(v, urgent=False)).add_done_callback(_quiet)
        else:
            ensure_download(v, urgent=False).add_done_callback(_quiet)
    return {"ok": True}


ALLOWED_IMG = ("googleusercontent.com", "ggpht.com", "ytimg.com")


@app.get("/api/img")
async def img(u: str):
    host = urlparse(u).hostname or ""
    if not any(host == h or host.endswith("." + h) for h in ALLOWED_IMG):
        raise HTTPException(400)
    r = await http.get(u)
    return Response(r.content, status_code=r.status_code, media_type=r.headers.get("content-type", "image/jpeg"), headers={"Cache-Control": "public, max-age=604800"})


@app.get("/api/health")
async def health():
    return {"ok": True, "cached": len(list(AUDIO.glob("*.m4a")))}


# ─────────────────────────────── статика ───────────────────────────────
class NoCacheStatic(StaticFiles):
    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        if path in ("", ".", "index.html", "sw.js") or path.endswith((".html", "sw.js")):
            resp.headers["Cache-Control"] = "no-cache"
        else:
            resp.headers["Cache-Control"] = "public, max-age=300"
        return resp


app.mount("/", NoCacheStatic(directory=WEB, html=True), name="web")


# ─────────────────────────────── тунель + gist ───────────────────────────────
GIST_FILE = DATA / "gist.txt"


def _gh(*args, input_text=None):
    return subprocess.run(["gh", *args], input=input_text, capture_output=True, text=True, encoding="utf-8", timeout=60)


def publish_url(url: str) -> str | None:
    """Записує поточну адресу тунелю в секретний gist, звідки її читає сайт на GitHub Pages."""
    if not shutil.which("gh"):
        print("  ! GitHub CLI (gh) не знайдено — адресу не опубліковано")
        return None
    body = json.dumps({"url": url, "at": int(time.time())})
    gid = GIST_FILE.read_text("utf-8").strip() if GIST_FILE.exists() else ""
    if gid:
        r = _gh("api", "-X", "PATCH", f"gists/{gid}", "--input", "-",
                input_text=json.dumps({"files": {"hvylia.json": {"content": body}}}))
        if r.returncode == 0:
            return gid
    tmp = DATA / "hvylia.json"
    tmp.write_text(body, "utf-8")
    r = _gh("gist", "create", str(tmp), "--desc", "hvylia server address")
    tmp.unlink(missing_ok=True)
    if r.returncode != 0:
        print("  ! Не вдалося створити gist:", r.stderr.strip()[:200])
        return None
    gid = r.stdout.strip().rstrip("/").split("/")[-1]
    GIST_FILE.write_text(gid, "utf-8")
    return gid


def find_cloudflared():
    cands = [shutil.which("cloudflared"), str(ROOT / "cloudflared.exe")]
    for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles")):
        if base:
            cands.append(str(Path(base) / "cloudflared" / "cloudflared.exe"))
    local = os.environ.get("LOCALAPPDATA")
    if local:
        cands += [str(p) for p in (Path(local) / "Microsoft" / "WinGet" / "Packages").glob("Cloudflare.cloudflared*/*.exe")]
        cands.append(str(Path(local) / "Microsoft" / "WinGet" / "Links" / "cloudflared.exe"))
    return next((c for c in cands if c and Path(c).exists()), None)


def start_tunnel(port: int):
    exe = find_cloudflared()
    if not exe:
        return None, None
    proc = subprocess.Popen([exe, "tunnel", "--no-autoupdate", "--url", f"http://localhost:{port}"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    import atexit
    atexit.register(proc.terminate)
    found: list[str] = []
    ev = threading.Event()

    def reader():
        for line in proc.stdout:
            m = re.search(r"https://(?!api\.)[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com", line)
            if m and not found:
                found.append(m.group(0))
                ev.set()

    threading.Thread(target=reader, daemon=True).start()
    ev.wait(45)
    if not found:
        proc.terminate()
        return None, None
    return found[0], proc


def show_qr(text: str):
    try:
        import qrcode
        q = qrcode.QRCode(border=1)
        q.add_data(text)
        q.print_ascii(invert=True)
    except Exception:
        pass


if __name__ == "__main__":
    import socket

    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
    except OSError:
        ip = "127.0.0.1"
    try:
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    except Exception:
        pass
    print(f"\n  Хвиля запущена:\n   • на цьому ПК:  http://localhost:{port}\n   • з телефону (та сама Wi-Fi):  http://{ip}:{port}\n")

    def tunnel_job():
        if os.environ.get("TUNNEL", "1") == "0":
            return
        if not find_cloudflared():
            print("  ! cloudflared не встановлено — доступ лише з домашньої Wi-Fi")
            return
        shown = warned = False
        while True:
            url, proc = start_tunnel(port)
            if not url:
                if not warned:
                    print("  ! Не вдалося відкрити тунель (Cloudflare не відповідає). Пробую знову щохвилини…")
                    warned = True
                time.sleep(60)
                continue
            warned = False
            gid = publish_url(url)
            print(f"  • тунель: {url}")
            if gid and not shown:
                shown = True
                link = f"{PAGES_URL}#/setup?g={gid}&k={KEY}"
                print(f"\n  Посилання для телефону (відкрий один раз, далі все автоматично):\n  {link}\n")
                show_qr(link)
                print("  Не показуй це посилання іншим — у ньому ключ доступу.\n")
            proc.wait()
            print("  ! Тунель перервався — перепідключаю…")
            time.sleep(5)

    threading.Thread(target=tunnel_job, daemon=True).start()
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")
