import io, csv, uuid, json, os
from datetime import datetime, timezone
from fastapi import FastAPI, UploadFile, Form, HTTPException, Header
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from app.s3 import put_bytes, put_json, get_json, list_keys, object_exists

app = FastAPI()
TOKEN = os.environ["UPLOAD_TOKEN"]


def auth(t):
    if t != TOKEN:
        raise HTTPException(401, "unauthorized")


@app.get("/health")
def health():
    return {"ok": True}


app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/scan")
def scan_page():
    return FileResponse("static/scan.html")


@app.post("/session/start")
def start(device_id: str = Form(...), scan_settings: str = Form("{}"),
          x_upload_token: str = Header(None)):
    auth(x_upload_token)
    sid = str(uuid.uuid4())
    put_json(f"sessions/{sid}/_session.json", {
        "scan_session_id": sid,
        "device_id": device_id,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "scan_settings": json.loads(scan_settings),
    })
    return {"scan_session_id": sid}


@app.post("/upload")
async def upload(
    sid: str = Form(...),
    frame_id: str = Form(...),
    epoch_ms: int = Form(...),
    lat: float = Form(...),
    lon: float = Form(...),
    gps_accuracy_m: float = Form(...),
    speed_mps: float = Form(...),
    bearing_deg: float = Form(...),
    image: UploadFile = None,
    x_upload_token: str = Header(None),
):
    auth(x_upload_token)
    if not image or not image.content_type.startswith("image/"):
        raise HTTPException(400, "image required")
    if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
        raise HTTPException(400, "invalid coordinates")
    if not object_exists(f"sessions/{sid}/_session.json"):
        raise HTTPException(404, "session not found")

    data = await image.read()
    if len(data) == 0:
        raise HTTPException(400, "empty image")
    if len(data) > 5_000_000:
        raise HTTPException(413, "image too large (max 5 MB)")

    put_bytes(f"sessions/{sid}/frames/{frame_id}.jpg", data, "image/jpeg")
    put_json(f"sessions/{sid}/meta/{frame_id}.json", {
        "frame_id": frame_id,
        "epoch_ms": epoch_ms,
        "lat": lat,
        "lon": lon,
        "gps_accuracy_m": gps_accuracy_m,
        "speed_mps": speed_mps,
        "bearing_deg": bearing_deg,
        "image_key": f"sessions/{sid}/frames/{frame_id}.jpg",
    })
    return {"ok": True}


@app.post("/session/end")
def end(sid: str = Form(...), partial: str = Form("false"),
        x_upload_token: str = Header(None)):
    auth(x_upload_token)
    session_key = f"sessions/{sid}/_session.json"
    if not object_exists(session_key):
        raise HTTPException(404, "session not found")

    rows = []
    for k in list_keys(f"sessions/{sid}/meta/"):
        try:
            rows.append(get_json(k))
        except Exception:
            continue

    if not rows:
        raise HTTPException(400, "no frames for this session")

    rows.sort(key=lambda r: r["epoch_ms"])
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)
    put_bytes(f"sessions/{sid}/metadata.csv",
              buf.getvalue().encode(), "text/csv")

    marker = get_json(session_key)
    marker["ended_at"] = datetime.now(timezone.utc).isoformat()
    marker["frame_count"] = len(rows)
    marker["partial"] = partial == "true"
    put_json(session_key, marker)

    return {"ok": True, "frame_count": len(rows), "partial": partial == "true"}