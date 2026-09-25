# Self-hosting

The repository root is the whole app: static files and native ES modules, with no build step and no backend. Anything that serves files over HTTP can host it. A hosted instance behaves exactly like a local one: every CV stays in the visitor's browser, and the server never receives any of it.

## What to upload

Upload the repository folder. These parts are not needed on a server, and the Docker image and the Pages workflow leave them out:

| Path | What it is |
|---|---|
| `.git`, `.github` | version control and CI |
| `test/` | Node tests |
| `docs/superpowers/` | design notes |
| `out/` | PDFs written by the smoke test |

`cli/`, `scripts/` and `serve.js` are Node tools. They are harmless on a static host, and the browser never loads them. The app works from any sub-path (for example `https://example.com/cv/`) because every URL in it is relative.

## Requirements for the host

- **HTTP or HTTPS, not `file://`.** Browsers block ES modules on `file://` URLs.
- **Correct MIME types.** `.js` must be served as `text/javascript` (or `application/javascript`), otherwise the browser refuses to run the modules. `.json` as `application/json`, `.css` as `text/css` and `.svg` as `image/svg+xml`. Every mainstream static host and web server does this by default.
- **No rewriting of `index.html`.** The Content-Security-Policy is a `<meta>` tag in `index.html`. You may also send it as a response header. If you do, use exactly the same policy:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; object-src 'none'; base-uri 'none'; form-action 'none'
```

`connect-src` allows `https:` and `localhost`/`127.0.0.1` on top of the app's own origin, because AI is opt-in and BYO-provider (see [assist.md](assist.md)): once a visitor connects a provider in the **AI** dialog, the page talks to that provider's API (or a local Ollama/LM Studio server) directly from the browser. No request happens until a visitor connects one, and only the provider they chose ever receives anything. Don't inject analytics, chat widgets or other third-party scripts — the CSP's `script-src 'self'` still blocks any script that isn't your own, so they wouldn't run, but they also have no business here.

## Local: `node serve.js`

```sh
node serve.js                         # http://127.0.0.1:8710
node serve.js --port 9000
node serve.js --host 0.0.0.0          # reachable from other machines on your network
```

`serve.js` is a small, zero-dependency server. It binds to `127.0.0.1` by default, and if the port is taken it tries the next one (up to 10 attempts) and prints the URL it used. It blocks path traversal, serves no directory listings and sets correct MIME types. It is meant for your own machine. For a public server, use nginx, Caddy or a static host.

### The `/api/fetch` job-link proxy

`serve.js` also answers `GET /api/fetch?url=<job posting URL>`, fetches that page server-side and returns its extracted text. The Job tab uses it so that a pasted link to a posting that isn't on Greenhouse, Lever or Ashby (whose public APIs allow direct browser requests) can still be turned into job text without asking the visitor to paste it by hand.

The route only exists when the server is actually bound to a loopback address (`127.0.0.1`/`localhost`) — `--host 0.0.0.0` or any other bind address disables it, and it also checks the incoming `Host` header so a page on another origin can't reach it by DNS rebinding. Every request is SSRF-guarded: the target's resolved IPs (and every redirect hop's, up to 5) must be public — private, loopback, link-local and other reserved ranges are all blocked, including IPv4-mapped and 6to4 forms that could otherwise smuggle a private address past the check. The response is capped at 2 MB, times out after 10 seconds, and only `text/html`, `application/xhtml+xml` and `text/plain` content types are accepted.

**Static hosts (GitHub Pages, Netlify, S3, nginx serving plain files, …) have no server-side code, so this proxy doesn't exist there.** On a static host, Greenhouse, Lever and Ashby links still work (their APIs are fetched directly from the browser), and pasting a job posting's text always works everywhere. Any other link needs either a locally-run `node serve.js`, or the visitor pasting the text themselves — see [assist.md](assist.md#job-links).

Any other static server works too:

```sh
python3 -m http.server 8710
```

## Docker

The included `Dockerfile` copies the app into `nginx:alpine`:

```sh
docker build -t recto .
docker run --rm -p 8080:80 recto      # http://localhost:8080
```

`.dockerignore` keeps `.git`, `out`, `test` and `docs/superpowers` out of the image. Put TLS in front of it with your usual reverse proxy.

## GitHub Pages

The repository includes `.github/workflows/pages.yml`. On every push to `main` it copies the repository root (without `test`, `docs/superpowers`, `out` and the git metadata) and deploys it to GitHub Pages.

To use it in your fork:

1. Push the repository to GitHub.
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Push to `main`, or run the **Pages** workflow by hand from the **Actions** tab.

The site appears at `https://<user>.github.io/<repo>/`.

GitHub Pages is a static host with no `/api/fetch` proxy (see above). Everything else works the same: local suggestions, the match score, legitimacy checks, uploading a CV file, Greenhouse/Lever/Ashby job links, and pasting a job posting's text. Only pasting an arbitrary other job URL needs a locally-run instance instead.

## Other static hosts

- **Netlify, Cloudflare Pages, Vercel:** create a site from the repository with no build command and `.` as the output (publish) directory.
- **S3, Azure Blob Storage, Google Cloud Storage:** upload the folder and turn on static website hosting. Check that `.js` files get a JavaScript content type: some upload tools guess `application/octet-stream` for unknown types.
- **nginx or Caddy:** point the document root at the folder. The default MIME types are correct.

## Updating

Replace the files with a newer release. Documents live in each visitor's browser (`localStorage` and IndexedDB), keyed by origin, so they survive an update as long as the site keeps the same origin. Old `.cv.json` files are migrated when they are opened. If you move the app to another domain, visitors must export their CVs from the old one (**Export → Recto file (.cv.json)**) and open them on the new one.
