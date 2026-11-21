# Rise Hub Live Metadata API

A Python/FastAPI service for extracting **real, publicly exposed page metadata** for Rise Hub. It returns title, developer/author when exposed, description, icon, images, JSON-LD application fields, and published rating/review-count metadata when the page actually provides them.

## Important limits

- This is not a universal bypass. Some sites block bots, render data in JavaScript, require sign-in, or do not expose reviews/screenshots in page HTML.
- It does not fabricate ratings/reviews, scrape private account data, or bypass CAPTCHA/paywalls/access controls.
- Use official APIs or authorized feeds for app-store catalogs and complete review data. Follow the source site's terms and robots policy.
- This service only fetches public HTTP(S) HTML, blocks private/local network destinations, limits redirects and response size, and has a timeout. Before exposing it publicly, add rate limiting and authentication appropriate to your deployment.

## Run locally

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000/docs`, or try `/api/scrape?url=https%3A%2F%2Fexample.com`.

## Deploy

Deploy this directory/service to a Python host that supports FastAPI (for example, Render or Railway). Start command:

```bash
uvicorn main:app --host 0.0.0.0 --port $PORT
```

Once deployed, set the resulting HTTPS base URL in the Rise Hub Android/WebView catalog loader. A Python file in the GitHub repository does not run inside the Android app by itself; it must run on a server.

## API

- `GET /health`
- `GET /api/scrape?url=<URL-encoded-public-page-url>`
- `GET /docs` (interactive API docs)

The API returns a JSON object. Missing fields are `null` or empty arrays rather than made-up content. `image_url` is generally a page preview/cover image, not guaranteed to be a full screenshot gallery.
