import os
import mimetypes
from uuid import uuid4
from typing import Dict, Any, Optional
from datetime import datetime, timezone

import asyncpg
from fastapi import FastAPI, UploadFile, File, HTTPException, Body, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import bcrypt
import jwt  # PyJWT
# защита от неправильного пакета "jwt"
if not hasattr(jwt, "encode") or not hasattr(jwt, "decode"):
    raise RuntimeError("Wrong jwt package installed. Ensure PyJWT is in requirements and `jwt` is not.")

import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import BotoCoreError, ClientError

# ===== ENV =====
DATABASE_URL = os.environ.get("DATABASE_URL")
CORS_ORIGINS = os.environ.get("CORS_ORIGINS", "")
R2_ENDPOINT = os.environ.get("R2_ENDPOINT")
R2_BUCKET = os.environ.get("R2_BUCKET")
R2_ACCESS_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID")
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY")
JWT_SECRET = os.environ.get("RECOVERY_SECRET", "devsecret")
JWT_ALG = "HS256"
SESSION_COOKIE = "foody_session"
NO_PHOTO_URL = "https://foodyweb-production.up.railway.app/img/no-photo.png"

# ===== APP / CORS =====
app = FastAPI()
_pool: asyncpg.pool.Pool | None = None
origins = [o.strip() for o in CORS_ORIGINS.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins or ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ===== helpers =====
def _hash_pw(pw: str) -> str:
    return bcrypt.hashpw(pw.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

def _check_pw(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False

def _issue_jwt(user_id: int) -> str:
    payload = {"sub": user_id, "iat": int(datetime.utcnow().timestamp())}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)

def _decode_jwt(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except Exception:
        return None

async def get_current_user(req: Request):
    token = req.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    data = _decode_jwt(token)
    if not data or "sub" not in data:
        raise HTTPException(status_code=401, detail="Invalid token")
    uid = int(data["sub"])
    async with _pool.acquire() as conn:
        row = await conn.fetchrow("SELECT id, phone, name FROM users WHERE id=$1", uid)
    if not row:
        raise HTTPException(status_code=401, detail="User not found")
    return dict(row)

def _cookie_response(payload: dict, token: str) -> JSONResponse:
    resp = JSONResponse(payload)
    resp.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        httponly=True,
        secure=True,
        samesite="lax",
        max_age=60 * 60 * 24 * 30,
        path="/",
    )
    return resp

# ===== auto-migrations (idempotent) =====
DDL = """
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS organizations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS organization_users (
  org_id INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'owner',
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS locations (
  id SERIAL PRIMARY KEY,
  org_id INT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  city TEXT,
  address_line TEXT,
  closing_time TEXT,
  timezone TEXT,
  logo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- совместимость со старой схемой
CREATE TABLE IF NOT EXISTS merchants (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS offers (
  id SERIAL PRIMARY KEY,
  merchant_id INT REFERENCES merchants(id) ON DELETE SET NULL,
  -- location_id добавим через ALTER ниже, чтобы не падать на старых БД
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  price NUMERIC(12,2) NOT NULL,
  stock INT NOT NULL DEFAULT 1,
  image_url TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_offers_expires ON offers(expires_at);
CREATE INDEX IF NOT EXISTS idx_offers_status  ON offers(status);
"""

ALTERS = [
    # расширим merchants на случай старых установок
    "ALTER TABLE merchants  ADD COLUMN IF NOT EXISTS city TEXT",
    "ALTER TABLE merchants  ADD COLUMN IF NOT EXISTS address_line TEXT",
    "ALTER TABLE merchants  ADD COLUMN IF NOT EXISTS closing_time TEXT",
    "ALTER TABLE merchants  ADD COLUMN IF NOT EXISTS timezone TEXT",
    # добавим колонку location_id, если её ещё нет
    "ALTER TABLE offers     ADD COLUMN IF NOT EXISTS location_id INT REFERENCES locations(id) ON DELETE CASCADE",
]

INDEXES_AFTER_ALTERS = [
    "CREATE INDEX IF NOT EXISTS idx_offers_location ON offers(location_id)"
]

@app.on_event("startup")
async def startup():
    global _pool
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL missing")
    _pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=5)
    async with _pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(DDL)
            for sql in ALTERS:
                await conn.execute(sql)
            # индекс по location_id создаём только после добавления колонки
            for sql in INDEXES_AFTER_ALTERS:
                await conn.execute(sql)

@app.get("/health")
async def health():
    return {"ok": True}

# ===== R2 upload =====
def _r2_client():
    if not all([R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY]):
        raise RuntimeError("R2 env not configured")
    return boto3.client(
        "s3",
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        config=BotoConfig(signature_version="s3v4"),
        region_name="auto",
    )

def _pub_url_or_none(key: str) -> Optional[str]:
    try:
        host = R2_ENDPOINT.split("//", 1)[-1]
        account = host.split(".", 1)[0]
        return f"https://pub-{account}.r2.dev/{R2_BUCKET}/{key}"
    except Exception:
        return None

@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    try:
        ext = os.path.splitext(file.filename or "")[1].lower() or ".jpg"
        if ext not in [".jpg", ".jpeg", ".png", ".webp"]:
            raise HTTPException(status_code=400, detail="Unsupported image type")

        content = await file.read()
        key = f"offers/{uuid4().hex}{ext}"

        s3 = _r2_client()
        ctype = file.content_type or mimetypes.guess_type(file.filename or "")[0] or "application/octet-stream"
        s3.put_object(Bucket=R2_BUCKET, Key=key, Body=content, ContentType=ctype)

        public_url = _pub_url_or_none(key)
        display_url = public_url or s3.generate_presigned_url(
            ClientMethod="get_object",
            Params={"Bucket": R2_BUCKET, "Key": key},
            ExpiresIn=60 * 60 * 24 * 365,  # 1 год
        )
        return {"url": public_url, "display_url": display_url, "key": key}
    except (BotoCoreError, ClientError) as e:
        print("UPLOAD_ERROR_S3:", repr(e))
        raise HTTPException(status_code=500, detail=f"Upload failed (S3): {e}")
    except Exception as e:
        print("UPLOAD_ERROR:", repr(e))
        raise HTTPException(status_code=500, detail=f"Upload failed: {e}")

# ===== AUTH =====
@app.post("/auth/register")
async def register(payload: Dict[str, Any] = Body(...)):
    for r in ["name", "phone", "password"]:
        if not str(payload.get(r, "")).strip():
            raise HTTPException(status_code=400, detail=f"Field {r} is required")

    name = payload["name"].strip()
    phone = payload["phone"].strip()
    password_hash = _hash_pw(payload["password"])
    city = (payload.get("city") or "").strip()
    address_line = (payload.get("address_line") or "").strip()
    closing_time = (payload.get("closing_time") or "").strip()
    timezone_str = (payload.get("timezone") or "").strip()

    async with _pool.acquire() as conn:
        async with conn.transaction():
            u = await conn.fetchrow("SELECT id FROM users WHERE phone=$1", phone)
            if u:
                raise HTTPException(status_code=409, detail="Phone already registered")

            user_id = await conn.fetchval(
                "INSERT INTO users (phone, password_hash, name) VALUES ($1,$2,$3) RETURNING id",
                phone, password_hash, name
            )

            org_id = await conn.fetchval(
                "INSERT INTO organizations (name) VALUES ($1) RETURNING id",
                name
            )
            await conn.execute(
                "INSERT INTO organization_users (org_id, user_id, role) VALUES ($1,$2,'owner')",
                org_id, user_id
            )

            loc_id = await conn.fetchval(
                """
                INSERT INTO locations (org_id, name, city, address_line, closing_time, timezone)
                VALUES ($1,$2,$3,$4,$5,$6)
                RETURNING id
                """,
                org_id, name, city, address_line, closing_time, timezone_str
            )

    token = _issue_jwt(user_id)
    return _cookie_response({"user_id": user_id, "org_id": org_id, "location_id": loc_id}, token)

@app.post("/auth/login")
async def login(payload: Dict[str, Any] = Body(...)):
    phone = (payload.get("phone") or "").strip()
    password = payload.get("password") or ""
    if not phone or not password:
        raise HTTPException(status_code=400, detail="Phone and password are required")

    async with _pool.acquire() as conn:
        user = await conn.fetchrow("SELECT id, password_hash FROM users WHERE phone=$1", phone)
        if not user or not _check_pw(password, user["password_hash"]):
            raise HTTPException(status_code=401, detail="Invalid credentials")

    token = _issue_jwt(user["id"])
    return _cookie_response({"user_id": user["id"]}, token)

@app.get("/auth/me")
async def me(user = Depends(get_current_user)):
    async with _pool.acquire() as conn:
        orgs = await conn.fetch("""
          SELECT o.id, o.name, ou.role
          FROM organization_users ou
          JOIN organizations o ON o.id = ou.org_id
          WHERE ou.user_id=$1
        """, user["id"])
        locs = await conn.fetch("""
          SELECT l.id, l.org_id, l.name, l.city, l.address_line, l.closing_time, l.timezone
          FROM locations l
          WHERE l.org_id IN (SELECT org_id FROM organization_users WHERE user_id=$1)
          ORDER BY l.id
        """, user["id"])
    return {"user": user, "organizations": [dict(x) for x in orgs], "locations": [dict(x) for x in locs]}

@app.post("/auth/logout")
async def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(SESSION_COOKIE, path="/")
    return resp

# ===== Offers (location-based) =====
def _parse_expires_at(value: str) -> datetime:
    if not value:
        raise ValueError("expires_at is empty")
    v = value.strip()
    try:
        dt = datetime.strptime(v, "%Y-%m-%d %H:%M")
        return dt.replace(tzinfo=timezone.utc)
    except ValueError:
        dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt

@app.post("/merchant/offers")
async def create_offer(payload: Dict[str, Any] = Body(...), user = Depends(get_current_user)):
    for r in ["title", "price", "stock", "expires_at"]:
        if not str(payload.get(r, "")).strip():
            raise HTTPException(status_code=400, detail=f"Field {r} is required")

    async with _pool.acquire() as conn:
        loc_id = payload.get("location_id")
        if loc_id:
            own = await conn.fetchval("""
                SELECT 1 FROM locations l
                WHERE l.id=$1 AND l.org_id IN (SELECT org_id FROM organization_users WHERE user_id=$2)
            """, int(loc_id), user["id"])
            if not own:
                raise HTTPException(status_code=403, detail="No access to location")
        else:
            row = await conn.fetchrow("""
                SELECT l.id FROM locations l
                WHERE l.org_id IN (SELECT org_id FROM organization_users WHERE user_id=$1)
                ORDER BY l.id LIMIT 1
            """, user["id"])
            if not row:
                raise HTTPException(status_code=400, detail="No locations found")
            loc_id = row["id"]

        image_url = (payload.get("image_url") or "").strip() or NO_PHOTO_URL
        expires_dt = _parse_expires_at(payload["expires_at"])

        row = await conn.fetchrow("""
            INSERT INTO offers
              (location_id, title, description, price, stock, category, image_url, expires_at, status, created_at)
            VALUES
              ($1, $2, $3, $4, $5, COALESCE($6,'other'), $7, $8, 'active', NOW())
            RETURNING id
        """,
        int(loc_id),
        payload.get("title"),
        payload.get("description"),
        payload.get("price"),
        int(payload.get("stock")),
        payload.get("category"),
        image_url,
        expires_dt)

    return {"id": row["id"]}

@app.get("/public/offers")
async def public_offers():
    async with _pool.acquire() as conn:
        rows = await conn.fetch("""
          SELECT o.id, o.title, o.description, o.price, o.stock, o.category,
                 o.image_url, o.expires_at, o.status,
                 l.id AS location_id, l.name AS merchant_name, l.address_line AS address, l.city
          FROM offers o
          JOIN locations l ON l.id = o.location_id
          WHERE o.status = 'active'
            AND o.expires_at > NOW()
            AND o.stock > 0
          ORDER BY o.expires_at ASC
          LIMIT 200
        """)
    return [dict(r) for r in rows]

# ===== Legacy aliases (back-compat) =====
@app.post("/api/v1/merchant/register_public")
async def legacy_register(payload: Dict[str, Any] = Body(...)):
    # старая короткая форма (name+phone). Если нет пароля — генерируем.
    name  = (payload.get("name") or payload.get("merchant_name") or "").strip()
    phone = (payload.get("phone") or payload.get("login") or "").strip()
    password = (payload.get("password") or payload.get("pass") or "").strip()
    if not password:
        import secrets, string
        alphabet = string.ascii_letters + string.digits
        password = "".join(secrets.choice(alphabet) for _ in range(12))

    mapped = {
        "name": name,
        "phone": phone,
        "password": password,
        "city": (payload.get("city") or "").strip(),
        "address_line": (payload.get("address_line") or payload.get("address") or "").strip(),
        "closing_time": (payload.get("closing_time") or "").strip(),
        "timezone": (payload.get("timezone") or "").strip(),
    }
    return await register(mapped)

@app.post("/api/v1/merchant/login_public")
async def legacy_login(payload: Dict[str, Any] = Body(...)):
    mapped = {
        "phone": payload.get("phone") or payload.get("login") or "",
        "password": payload.get("password") or "",
    }
    return await login(mapped)

@app.get("/api/v1/merchant/me")
async def legacy_me(user = Depends(get_current_user)):
    return await me(user)
