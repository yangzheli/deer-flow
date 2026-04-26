"""LangGraph Server auth handler — shares JWT logic with Gateway.

Loaded by LangGraph Server via langgraph.json ``auth.path``.
Reuses the same ``decode_token`` / ``get_auth_config`` as Gateway,
so both modes validate tokens with the same secret and rules.

Two layers:
  1. @auth.authenticate — validates JWT cookie, extracts user_id,
     and enforces CSRF on state-changing methods (POST/PUT/DELETE/PATCH)
  2. @auth.on — returns metadata filter so each user only sees own threads
"""

import asyncio
import logging
import secrets

from langgraph_sdk import Auth

from app.gateway.auth.errors import TokenError
from app.gateway.auth.jwt import decode_token
from app.gateway.deps import get_local_provider

logger = logging.getLogger(__name__)

auth = Auth()

# LangGraph Server runs as a separate process from the FastAPI Gateway and
# does not execute Gateway's lifespan startup. We must therefore lazily
# initialize the SQLAlchemy engine on first auth request so that
# ``get_local_provider()`` can construct its repository against a real
# session factory. ``_engine_init_done`` short-circuits the fast path; the
# lock ensures concurrent first requests do not race the init.
_engine_init_lock = asyncio.Lock()
_engine_init_done = False


async def _ensure_engine() -> None:
    """Idempotently initialize the persistence engine in this process.

    Skip when already initialized (Gateway path) or already attempted.
    Safe to call concurrently from multiple authenticate handlers.
    """
    global _engine_init_done
    if _engine_init_done:
        return

    from deerflow.persistence.engine import get_session_factory, init_engine_from_config

    if get_session_factory() is not None:
        _engine_init_done = True
        return

    async with _engine_init_lock:
        if _engine_init_done or get_session_factory() is not None:
            _engine_init_done = True
            return
        from deerflow.config import get_app_config

        config = get_app_config().database
        await init_engine_from_config(config)
        _engine_init_done = True
        logger.info("LangGraph Server: persistence engine lazily initialized (backend=%s)", config.backend)


# Methods that require CSRF validation (state-changing per RFC 7231).
_CSRF_METHODS = frozenset({"POST", "PUT", "DELETE", "PATCH"})


def _check_csrf(request) -> None:
    """Enforce Double Submit Cookie CSRF check for state-changing requests.

    Mirrors Gateway's CSRFMiddleware logic so that LangGraph routes
    proxied directly by nginx have the same CSRF protection.
    """
    method = getattr(request, "method", "") or ""
    if method.upper() not in _CSRF_METHODS:
        return

    cookie_token = request.cookies.get("csrf_token")
    header_token = request.headers.get("x-csrf-token")

    if not cookie_token or not header_token:
        raise Auth.exceptions.HTTPException(
            status_code=403,
            detail="CSRF token missing. Include X-CSRF-Token header.",
        )

    if not secrets.compare_digest(cookie_token, header_token):
        raise Auth.exceptions.HTTPException(
            status_code=403,
            detail="CSRF token mismatch.",
        )


@auth.authenticate
async def authenticate(request):
    """Validate the session cookie, decode JWT, and check token_version.

    Same validation chain as Gateway's get_current_user_from_request:
      cookie → decode JWT → DB lookup → token_version match
    Also enforces CSRF on state-changing methods.
    """
    # CSRF check before authentication so forged cross-site requests
    # are rejected early, even if the cookie carries a valid JWT.
    _check_csrf(request)

    token = request.cookies.get("access_token")
    if not token:
        raise Auth.exceptions.HTTPException(
            status_code=401,
            detail="Not authenticated",
        )

    payload = decode_token(token)
    if isinstance(payload, TokenError):
        raise Auth.exceptions.HTTPException(
            status_code=401,
            detail=f"Token error: {payload.value}",
        )

    # Ensure the persistence engine is initialized in this (LangGraph Server)
    # process before reaching for the user repository.
    await _ensure_engine()

    user = await get_local_provider().get_user(payload.sub)
    if user is None:
        raise Auth.exceptions.HTTPException(
            status_code=401,
            detail="User not found",
        )
    if user.token_version != payload.ver:
        raise Auth.exceptions.HTTPException(
            status_code=401,
            detail="Token revoked (password changed)",
        )

    return payload.sub


@auth.on
async def add_owner_filter(ctx: Auth.types.AuthContext, value: dict):
    """Inject user_id metadata on writes; filter by user_id on reads.

    Gateway stores thread ownership as ``metadata.user_id``.
    This handler ensures LangGraph Server enforces the same isolation.
    """
    # On create/update: stamp user_id into metadata
    metadata = value.setdefault("metadata", {})
    metadata["user_id"] = ctx.user.identity

    # Return filter dict — LangGraph applies it to search/read/delete
    return {"user_id": ctx.user.identity}
