---
title: "When a Cache Miss Becomes a Database Incident"
description: "How cache stampedes overload databases, and how single-flight loading, Redis locks, stale responses, TTL jitter, and observability prevent them."
pubDate: 2026-09-14
heroImage: "../../assets/cache-stampede-cover.png"
---

The `GET /api/trending-products` endpoint is working well.

Redis serves the popular response in a few milliseconds. The database is healthy. Traffic is normal.

Then a five-minute cache entry expires.

Within a second, a large number of requests arrive for the same key. They all see a cache miss. They all run the same expensive database query. The connection pool fills, latency rises, and client retries add even more load.

Nothing was wrong with the cache while it existed. The problem began when the cache disappeared.

This is a **cache stampede**. It is a concurrency problem that can turn one expired hot key into a database incident.

> A cache miss should not mean that every request is allowed to rebuild the same value.

## What a cache stampede is

Assume this cache key:

```text
Key: trending_products
TTL: 5 minutes
```

While the key exists, the request path is simple:

```text
1,000 requests
      │
      ▼
    Redis
      │
      ▼
Cached response
```

At the moment it expires, the same traffic can become this:

```text
Request A ─┐
Request B ─┤
Request C ─┼── cache miss ──► identical database queries
Request D ─┤
Request E ─┘
```

The database now receives the same expensive work many times. If a query takes 200 ms and hundreds of requests start it together, the impact is much larger than one slow query.

```text
Database work increases
          ↓
Connection pool fills
          ↓
Requests wait for connections
          ↓
API latency rises
          ↓
Timeouts and retries create more traffic
```

That feedback loop is what makes a stampede dangerous.

## The code that creates the problem

This cache-aside pattern looks correct in isolation:

```python
import json

async def get_trending_products() -> list[dict]:
    cached = await redis.get("trending_products")

    if cached is not None:
        return json.loads(cached)

    products = await load_trending_products_from_database()

    await redis.set(
        "trending_products",
        json.dumps(products),
        ex=300,
    )

    return products
```

The race appears when many requests execute it at nearly the same time:

```text
Request A → Redis GET → miss
Request B → Redis GET → miss
Request C → Redis GET → miss
              ↓
      All three call the database
```

The cache protects the database only while the value is present. When it expires, every request assumes that it is responsible for rebuilding it.

It is also useful to distinguish related problems:

| Problem | What happens | Typical protection |
| --- | --- | --- |
| Cache stampede | Many requests rebuild one expired value | Single-flight, distributed lock, stale-while-revalidate |
| Thundering herd | Many requests wake up or arrive together and overload a shared resource | Coalescing, queueing, backpressure |
| Cache penetration | Repeated requests ask for data that does not exist | Short negative-cache entries, validation, rate limits |

## The fix: one owner for one rebuild

For a hot cache key, only one request should do the expensive regeneration work. The other requests should reuse the result, wait briefly, receive an acceptable stale response, or fail in a controlled way.

This pattern is commonly called **single-flight**, **request coalescing**, or **cache-stampede protection**.

```text
1,000 requests
      │
      ▼
Try to become refresh owner
      │
 ┌────┴────┐
 ▼         ▼
Owner    Waiters
 │         │
 ▼         │
Database   │
 │         │
 ▼         │
Populate cache
 └────┬────┘
      ▼
All requests receive the cached value
```

## Why one local lock is not enough

Inside one application process, an in-memory lock or an in-flight promise can prevent duplicate work. It is not enough for a deployed service with multiple instances:

```text
Load balancer
      │
  ┌───┼───┐
  ▼   ▼   ▼
API-1 API-2 API-3
  │     │    │
lock A lock B lock C
```

Each instance has its own memory and its own lock. Three instances can still run three identical database queries. For multiple instances, use a shared coordination mechanism such as Redis.

## A Redis distributed-lock implementation

The following example uses a Redis lock so that only one instance refreshes a missing value. It uses a unique token and only releases a lock when the stored token still belongs to the caller.

```python
import asyncio
import json
import random
import uuid
from typing import Any

from redis.asyncio import Redis

redis = Redis(host="localhost", port=6379, decode_responses=True)

CACHE_TTL_SECONDS = 300
# This must exceed normal refresh time; renew the lease if refreshes can run longer.
LOCK_TTL_SECONDS = 30
MAX_WAIT_SECONDS = 3

RELEASE_LOCK = """
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
end
return 0
"""


class CacheRefreshInProgress(Exception):
    """The cache is being rebuilt by another request."""


async def load_trending_products_from_database() -> list[dict[str, Any]]:
    # Replace with a real, bounded database query.
    await asyncio.sleep(0.2)
    return [{"id": 1, "name": "Product A"}]


async def release_lock(lock_key: str, token: str) -> None:
    await redis.eval(RELEASE_LOCK, 1, lock_key, token)


async def wait_for_cache(cache_key: str) -> list[dict[str, Any]]:
    """Wait briefly for the refresh owner instead of querying the database."""
    deadline = asyncio.get_running_loop().time() + MAX_WAIT_SECONDS

    while asyncio.get_running_loop().time() < deadline:
        cached = await redis.get(cache_key)
        if cached is not None:
            return json.loads(cached)

        # Jitter stops all waiters from polling Redis at the same instant.
        await asyncio.sleep(0.04 + random.uniform(0, 0.04))

    raise CacheRefreshInProgress(cache_key)


async def get_trending_products() -> list[dict[str, Any]]:
    cache_key = "trending_products"
    lock_key = f"lock:{cache_key}"

    cached = await redis.get(cache_key)
    if cached is not None:
        return json.loads(cached)

    token = str(uuid.uuid4())
    acquired = await redis.set(lock_key, token, nx=True, ex=LOCK_TTL_SECONDS)

    if not acquired:
        return await wait_for_cache(cache_key)

    try:
        # Another request may have filled the cache just before lock acquisition.
        cached = await redis.get(cache_key)
        if cached is not None:
            return json.loads(cached)

        products = await load_trending_products_from_database()
        await redis.set(cache_key, json.dumps(products), ex=CACHE_TTL_SECONDS)
        return products
    finally:
        await release_lock(lock_key, token)
```

At the API boundary, map a wait timeout to a controlled retry response. Do not query the database again just because the wait ended:

```python
from fastapi import HTTPException

async def trending_products_route():
    try:
        return await get_trending_products()
    except CacheRefreshInProgress as error:
        raise HTTPException(
            status_code=503,
            detail="Cache refresh in progress; retry shortly.",
            headers={"Retry-After": "1"},
        ) from error
```

A stale response is often a better choice when the data allows it.

## Why this implementation works

The lock is acquired with Redis `SET` using two important options:

```text
NX → create the lock only if it does not already exist
EX → expire the lock so a crashed process cannot hold it forever
```

The request that wins the lock becomes the refresh owner. Other requests poll only the cache for a short, jittered period. They do not fall back directly to the database, because that would recreate the stampede.

The second cache read after acquiring the lock is also deliberate. Another process may have filled the value in the tiny window between the first miss and lock acquisition.

## Why the lock needs a unique token

Never release a distributed lock with an unconditional `DEL`.

Consider this sequence:

```text
Request A acquires lock with token A
                ↓
The database call takes longer than the 30-second lock TTL
                ↓
Redis expires lock A
                ↓
Request B acquires a new lock with token B
                ↓
Request A finishes and blindly deletes the lock
```

Request A could accidentally delete Request B’s lock. The Lua script in the example deletes the lock only when its stored token still matches the request’s token.

The lock TTL must be longer than the normal refresh duration, with a safety margin. If refreshes can legitimately exceed it, consider lease renewal or redesign the refresh work. Do not simply set an extremely long TTL and forget about failure recovery.

## Decide what waiting requests should receive

There is no single correct answer after a request loses the lock. Choose the response based on what the data means to users.

| Situation | Good response |
| --- | --- |
| Slightly old data is acceptable | Serve a stale value and refresh in the background |
| Data must be current | Wait for a short bounded time, then return a controlled retryable error |
| Refresh can run ahead of demand | Warm or refresh the key in a background worker |
| Data is cheap and local | A short wait may be enough; do not add distributed locking unnecessarily |

The important point is to make the fallback explicit. A silent “wait timeout → query the database anyway” can create a second stampede.

## Other useful protections

### Serve stale data while refreshing

For homepages, product rankings, public content, and reference data, a slightly old result is often better than a slow or failed request.

```text
Fresh TTL: 5 minutes
Stale window: 2 minutes

0–5 minutes → serve fresh value
5–7 minutes → serve stale value and trigger one background refresh
7+ minutes → wait briefly for refresh or use a controlled fallback
```

This is **stale-while-revalidate**. It removes refresh latency from the user path, but it is not suitable for data that must be immediately consistent.

### Add TTL jitter

If many keys are created at the same time with the same TTL, they can expire together. Spread their expiration times:

```python
base_ttl_seconds = 300
jitter_seconds = random.randint(0, 60)

await redis.set(cache_key, value, ex=base_ttl_seconds + jitter_seconds)
```

Jitter reduces synchronized expiration across many keys. It does not replace single-flight protection for one very hot key.

### Warm predictable keys

For data such as homepage recommendations, popular products, configuration, or exchange rates, refresh the key before it expires:

```text
Scheduler → background worker → database → Redis
```

Cache warming is helpful when traffic and refresh schedules are predictable. It adds background work, so only warm keys that are valuable enough to justify it.

### Cache negative results briefly

Cache penetration is different from a stampede, but it can hurt the same database. If an ID does not exist, a short negative cache prevents repeated reads:

```text
Key: user:99999999
Value: NOT_FOUND
TTL: 30 seconds
```

Use a short TTL because the record might be created later. Pair negative caching with input validation and rate limits for public endpoints.

## Protect the database even when the cache fails

Redis is useful, but it should not be the only thing keeping the database healthy. Keep these guardrails as well:

- bounded connection pools;
- database query timeouts;
- request rate limits or backpressure;
- circuit breakers or a controlled degraded response;
- bounded retry policies;
- a deliberate plan for Redis unavailability.

If Redis is down, do not automatically let unlimited requests fall through to the database. Decide whether the endpoint can serve stale data, reject excess traffic, or safely allow a limited fallback.

## What to measure in production

Do not add cache-stampede protection and assume it works. Track what happens around hot keys and refreshes:

```text
cache_hit_rate
cache_miss_rate
cache_refresh_duration_ms
cache_refresh_count
lock_acquisition_success
lock_contention_count
cache_wait_duration_ms
stale_response_count
database_fallback_count
```

A 99% cache-hit rate can still hide a problem. A sudden rise in lock contention or refresh duration can mean the key is too expensive to rebuild, too short-lived, too hot, or invalidated too often.

A useful structured event could look like this:

```json
{
  "cache_key": "trending_products",
  "event": "cache_refresh",
  "lock_acquired": true,
  "refresh_duration_ms": 1840,
  "cache_ttl_seconds": 300
}
```

## A practical decision guide

```text
One application process
  → in-flight task / single-flight can be enough

Multiple application instances
  → Redis-backed distributed lock or another shared coordination mechanism

Hot endpoint where stale data is acceptable
  → stale-while-revalidate + one refresh owner

Predictable, important data
  → cache warming

Many keys created together
  → TTL jitter

Repeated requests for missing data
  → short negative-cache entries
```

## Final takeaway

A cache stampede is not mainly a cache problem. It is a concurrency problem.

The naive model is:

```text
Cache miss → query database
```

The production model is:

```text
Cache miss
      ↓
Is another request already rebuilding this value?
      ↓
Yes → reuse the result, wait briefly, or serve stale data
No  → become the single refresh owner
```

For a hot key, turn **N identical expensive operations** into **one refresh and N consumers**. That is the design decision that keeps an expired cache entry from becoming a database incident.
