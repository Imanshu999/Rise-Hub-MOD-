from __future__ import annotations

import ipaddress
import json
import socket
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

APP_VERSION = "1.0.0"
MAX_BYTES = 4 * 1024 * 1024
TIMEOUT = httpx.Timeout(15.0, connect=7.0)
USER_AGENT = "RiseHubCatalogBot/1.0 (+public-page-metadata; contact site owner to opt out)"

app = FastAPI(
    title="Rise Hub Live Metadata API",
    version=APP_VERSION,
    description="Extracts publicly exposed metadata from a user-supplied public web page. It does not invent reviews or bypass access controls.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


def validate_public_url(value: str) -> str:
    parsed = urlparse(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(400, "Only absolute HTTP or HTTPS URLs are supported.")
    if parsed.username or parsed.password:
        raise HTTPException(400, "URLs containing credentials are not allowed.")
    host = parsed.hostname.rstrip(".").lower()
    if host in {"localhost", "localhost.localdomain"} or host.endswith((".local", ".internal", ".test")):
        raise HTTPException(400, "Local and internal hostnames are not allowed.")
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)}
    except socket.gaierror:
        raise HTTPException(422, "The website hostname could not be resolved.")
    if not addresses:
        raise HTTPException(422, "The website hostname did not resolve to an address.")
    for address in addresses:
        ip = ipaddress.ip_address(address.split("%")[0])
        if not ip.is_global:
            raise HTTPException(400, "Private, local, and reserved network addresses are blocked.")
    return value.strip()


def safe_get(url: str) -> tuple[str, str, str]:
    current = validate_public_url(url)
    headers = {"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5"}
    with httpx.Client(timeout=TIMEOUT, follow_redirects=False, headers=headers) as client:
        for _ in range(6):
            current = validate_public_url(current)
            try:
                response = client.get(current)
            except httpx.TimeoutException:
                raise HTTPException(504, "The source website took too long to respond.")
            except httpx.HTTPError:
                raise HTTPException(502, "Could not fetch the source website.")
            if response.status_code in {301, 302, 303, 307, 308}:
                location = response.headers.get("location")
                if not location:
                    raise HTTPException(502, "The source returned an invalid redirect.")
                current = urljoin(current, location)
                continue
            if response.status_code in {401, 403, 429}:
                raise HTTPException(response.status_code, "The source website restricts automated access. Use its official API or an authorized feed.")
            if response.status_code >= 400:
                raise HTTPException(502, f"The source website returned HTTP {response.status_code}.")
            content_type = response.headers.get("content-type", "").lower()
            if not any(kind in content_type for kind in ("text/html", "application/xhtml+xml", "text/plain")):
                raise HTTPException(415, "This endpoint currently extracts HTML pages, not arbitrary binary files.")
            body = response.content
            if len(body) > MAX_BYTES:
                raise HTTPException(413, "The source page is larger than the 4 MB safety limit.")
            encoding = response.encoding or "utf-8"
            return current, body.decode(encoding, errors="replace"), content_type
    raise HTTPException(502, "Too many redirects from the source website.")


def clean(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (list, dict)):
        value = json.dumps(value, ensure_ascii=False)
    result = " ".join(str(value).split()).strip()
    return result or None


def absolute(base: str, value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    value = value.strip()
    if value.startswith(("data:", "javascript:", "blob:")):
        return None
    return urljoin(base, value)


def scrape_metadata(page_url: str, html: str) -> dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    metas: dict[str, str] = {}
    for tag in soup.find_all("meta"):
        key = tag.get("property") or tag.get("name") or tag.get("itemprop")
        value = tag.get("content")
        if key and value and key.lower() not in metas:
            metas[key.lower()] = value.strip()

    def first(*keys: str) -> str | None:
        for key in keys:
            value = metas.get(key.lower())
            if value and value.strip():
                return clean(value)
        return None

    title = first("og:title", "twitter:title", "name", "title")
    if not title and soup.title:
        title = clean(soup.title.get_text(" ", strip=True))
    description = first("og:description", "twitter:description", "description")
    site_name = first("og:site_name", "application-name")
    image = absolute(page_url, first("og:image", "og:image:url", "twitter:image", "twitter:image:src", "image"))
    icon_tag = soup.find("link", rel=lambda value: value and any("icon" in str(item).lower() for item in (value if isinstance(value, list) else [value])))
    icon = absolute(page_url, icon_tag.get("href")) if icon_tag else absolute(page_url, "/favicon.ico")

    developer = first("author", "article:author", "parsely-author", "twitter:creator")
    rating_value = first("ratingvalue", "rating", "aggregate-rating", "og:rating")
    rating_count = first("ratingcount", "reviewcount", "rating-count")
    review_count = first("reviewcount", "review-count")
    price = first("product:price:amount", "price")
    version = first("softwareversion", "version")
    category = first("applicationcategory", "category", "genre")
    published = first("datepublished", "article:published_time")
    modified = first("datemodified", "article:modified_time")

    screenshots: list[str] = []
    for tag in soup.find_all("meta"):
        key = (tag.get("property") or tag.get("name") or "").lower()
        if key in {"og:image", "og:image:url", "twitter:image", "twitter:image:src", "screenshot"}:
            candidate = absolute(page_url, tag.get("content"))
            if candidate and candidate not in screenshots:
                screenshots.append(candidate)

    structured: list[dict[str, Any]] = []
    for script in soup.find_all("script", attrs={"type": "application/ld+json"}):
        raw = script.string or script.get_text()
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            continue
        queue = parsed if isinstance(parsed, list) else [parsed]
        while queue:
            item = queue.pop(0)
            if isinstance(item, dict):
                if isinstance(item.get("@graph"), list):
                    queue.extend(item["@graph"])
                structured.append(item)

    def get_types(item: dict[str, Any]) -> set[str]:
        value = item.get("@type", [])
        if isinstance(value, str):
            value = [value]
        return {str(entry).lower() for entry in value}

    for item in structured:
        types = get_types(item)
        if not title and item.get("name"):
            title = clean(item.get("name"))
        if not description and item.get("description"):
            description = clean(item.get("description"))
        if not developer and item.get("author"):
            author = item.get("author")
            developer = clean(author.get("name") if isinstance(author, dict) else author)
        if not category and item.get("applicationCategory"):
            category = clean(item.get("applicationCategory"))
        if not version and item.get("softwareVersion"):
            version = clean(item.get("softwareVersion"))
        if item.get("image"):
            raw_images = item["image"] if isinstance(item["image"], list) else [item["image"]]
            for raw_image in raw_images:
                raw_image = raw_image.get("url") if isinstance(raw_image, dict) else raw_image
                candidate = absolute(page_url, raw_image)
                if candidate and candidate not in screenshots:
                    screenshots.append(candidate)
        aggregate = item.get("aggregateRating")
        if isinstance(aggregate, dict):
            rating_value = rating_value or clean(aggregate.get("ratingValue"))
            rating_count = rating_count or clean(aggregate.get("ratingCount"))
            review_count = review_count or clean(aggregate.get("reviewCount"))
        if "softwareapplication" in types or "mobileapplication" in types:
            category = category or clean(item.get("applicationCategory"))
            price = price or clean((item.get("offers") or {}).get("price") if isinstance(item.get("offers"), dict) else None)

    return {
        "source_url": page_url,
        "title": title,
        "site_name": site_name,
        "developer": developer,
        "description": description,
        "icon_url": icon,
        "image_url": image,
        "screenshots": screenshots[:30],
        "category": category,
        "version": version,
        "rating": rating_value,
        "rating_count": rating_count,
        "review_count": review_count,
        "price": price,
        "published_at": published,
        "modified_at": modified,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "data_source": "public page metadata / structured data",
        "notes": [
            "Only fields actually exposed by the source page are returned.",
            "A page's rating is not independently verified by this service.",
            "Full review text, app-store screenshots, and private data require an official API or permission when the source does not expose them.",
        ],
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "rise-hub-live-metadata", "version": APP_VERSION}


@app.get("/api/scrape")
def scrape(url: str = Query(..., min_length=8, max_length=2048)) -> dict[str, Any]:
    final_url, html, _content_type = safe_get(url)
    return scrape_metadata(final_url, html)


@app.get("/")
def root() -> dict[str, str]:
    return {
        "service": "Rise Hub Live Metadata API",
        "health": "/health",
        "scrape_example": "/api/scrape?url=https%3A%2F%2Fexample.com",
        "docs": "/docs",
    }
